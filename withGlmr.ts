import { ApiPromise, WsProvider } from '@polkadot/api';
import Keyring from '@polkadot/keyring';
import { BN } from "@polkadot/util";
import { ethers, providers } from 'ethers';
import secrets from './secrets';
import abi from './abi';

/*
REQUIREMENTS:
1. Hold xcFTM.wh on Moonbase Beta
2. Hold xcDEV (Alphanet's DEV) on Moonbase Beta

CURRENT IMPLEMENTATION:

In a single transaction, batch 2 xcm transactions:
1. xTokens.transferMultiassets transaction that sends xcFTM.wh & xcDEV, which uses xcDEV as the fee currency
2. Do an xcm-ethereum transaction paid for by the xcDEV sent over from the previous step. This tx interacts with the batch precompile:
  a. Approve tokens
  b. Cross-chain transaction

*/

// Endpoints
const ALPHA_ENDPOINT = 'wss://wss.api.moonbase.moonbeam.network';
const BETA_ENDPOINT = 'wss://frag-moonbase-beta-rpc-ws.g.moonbase.moonbeam.network';

// Smart Contracts & Addresses
const BATCH_PRECOMPILE_ADDRESS = '0x0000000000000000000000000000000000000808';
const WRAPPED_FTM_ADDRESS = '0x566c1cebc6A4AFa1C122E039C4BEBe77043148Ee';
const XLABS_RELAYER_ADDRESS = '0x9563a59c15842a6f322b10f69d1dd88b41f2e97b'; // MAINNET: 0xcafd2f0a35a4459fa40c0517e17e6fa2939441ca
const MLD_ACCOUNT = '0xD117eD760630549A4A8302BEC538B7b285751EcA';

// Constants
const AMOUNT_TO_SEND = "250000000000000000";
const DESTINATION_CHAIN_ID = 10; // Fantom
const BALANCE_PALLET = 3; // 10 on Moonbeam, 3 on Alphanet

// Create a keyring instance
const keyring = new Keyring({ type: 'ethereum' });
let account = keyring.addFromUri(secrets.privateKey);

async function main() {
  // Create the API interface
  const alphaWSProvider = new WsProvider(ALPHA_ENDPOINT);
  const alphaAPI = await ApiPromise.create({ provider: alphaWSProvider });
  const betaWSProvider = new WsProvider(BETA_ENDPOINT);
  const betaAPI = await ApiPromise.create({ provider: betaWSProvider });

  // Create transaction to send FTM and DEV, with DEV as the fee
  const sendFTMExtrinsic = betaAPI.tx.xTokens.transferMultiassets(
    { // assets
      V3: [
        { // xcDEV
          id: {
            Concrete: {
              parents: 1,
              interior: {
                X2: [
                  { Parachain: 1000 },
                  { PalletInstance: BALANCE_PALLET },
                ]
              }
            }
          },
          fun: {
            Fungible: "100000000000000000",
          }
        },
        { // WFTM
          id: {
            Concrete: {
              parents: 1,
              interior: {
                X3: [
                  { Parachain: 1000 },
                  { PalletInstance: 48 },
                  { AccountKey20: { key: WRAPPED_FTM_ADDRESS } }
                ]
              }
            }
          },
          fun: {
            Fungible: AMOUNT_TO_SEND,
          }
        }
      ]
    },
    0, // feeItem
    { // dest
      V3: {
        parents: 1,
        interior: {
          X2: [
            { Parachain: 1000 },
            { AccountKey20: { key: MLD_ACCOUNT } }
          ]
        }
      }
    },
    'Unlimited' // weight limit
  );

  console.log("===============================================");
  console.log("Send FTM Tx:", sendFTMExtrinsic.method.toHex());

  // Create & add ethereum tx to XCM message
  const ethereumTx = await batchApproveTransferTx(alphaAPI);
  const txWeight = (await ethereumTx.paymentInfo(MLD_ACCOUNT)).weight;
  console.log("===============================================");
  console.log("Payment Info for Transact:", txWeight.toString());
  const xcmExtrinsic = betaAPI.tx.polkadotXcm.send(
    { V3: { parents: new BN(1), interior: { X1: { Parachain: 1000 } } } },
    {
      V3: [
        // Withdraw DEV asset (0.06) from the target account
        {
          WithdrawAsset: [
            {
              id: { Concrete: { parents: new BN(0), interior: { X1: { PalletInstance: BALANCE_PALLET } } } },
              fun: { Fungible: new BN("60000000000000000") }
            }
          ]
        },
        // Buy execution with the DEV asset
        {
          BuyExecution: {
            fees:
            {
              id: { Concrete: { parents: new BN(0), interior: { X1: { PalletInstance: 3 } } } },
              fun: { Fungible: new BN("60000000000000000") }
            },
            weightLimit: 'Unlimited'
          }
        },
        {
          Transact: {
            originKind: "SovereignAccount",
            // https://docs.moonbeam.network/builders/interoperability/xcm/remote-evm-calls/#estimate-weight-required-at-most
            requireWeightAtMost: { refTime: txWeight.refTime, proofSize: txWeight.proofSize },
            call: {
              encoded: ethereumTx.method.toHex()
            }
          }
        },
        // {
        //   RefundSurplus: {}
        // },
        // {
        //   DepositAsset: {
        //     assets: { Wild: "All" },
        //     beneficiary: {
        //       parents: new BN(0),
        //       interior: { X1: { AccountKey20: { key: MLD_ACCOUNT } } },
        //     },
        //   },
        // }
      ]
    });

  return await xcmExtrinsic.signAndSend(account, ({ status }) => {
    if (status.isInBlock) {
      console.log("===============================================");
      console.log(`Moonbase Beta transaction successful!`);
      alphaAPI.disconnect();
      betaAPI.disconnect();
      return;
    }
  });

  console.log("===============================================");
  console.log("Remote EVM Tx:", xcmExtrinsic.method.toHex());

  // Wrap those in a batch transaction. This transaction will:
  // 1. Send FTM + DEV together
  // 2. Use the left over DEV as the fee currency to do the wormhole route
  const batchExtrinsic = betaAPI.tx.utility.batchAll([
    sendFTMExtrinsic,
    xcmExtrinsic,
  ]);
  console.log("===============================================");
  console.log('Batch Extrinsic:', batchExtrinsic.method.toHex());

  // Send batch transaction
  return await batchExtrinsic.signAndSend(account, ({ status }) => {
    if (status.isInBlock) {
      console.log("===============================================");
      console.log(`Moonbase Beta transaction successful!`);
      return;
    }
  });
}

// Creates an ethereumXCM extrinsic that approves WFTM + transfers tokens
async function batchApproveTransferTx(alphaAPI: ApiPromise) {
  // Get Batch, IERC20, ITokenBridge contracts
  const Batch = new ethers.utils.Interface(abi.Batch);
  const WrappedFTM = new ethers.utils.Interface(abi.IERC20);
  const TokenRelayer = new ethers.Contract(
    XLABS_RELAYER_ADDRESS,
    abi.TokenRelayer,
    new providers.JsonRpcProvider('https://moonbase-alpha.public.blastapi.io')
  );

  // Create contract calls & batch them
  const approveTx = WrappedFTM.encodeFunctionData("approve", [XLABS_RELAYER_ADDRESS, AMOUNT_TO_SEND]);
  console.log("APPROVE", approveTx);

  const relayerFee = await TokenRelayer.calculateRelayerFee(DESTINATION_CHAIN_ID, WRAPPED_FTM_ADDRESS, 18);
  console.log(`The relayer fee for this token will be ${relayerFee}.`);

  // TODO: replace with wrapAndTransferEthWithRelay if is GLMR
  const transferTx = TokenRelayer.interface.encodeFunctionData("transferTokensWithRelay", [
    WRAPPED_FTM_ADDRESS,
    AMOUNT_TO_SEND,
    0, // amount of natural currency to turn into fee? Should work on testnet as long as not 0
    DESTINATION_CHAIN_ID, // Target chain, Fantom
    '0x0000000000000000000000000394c0EdFcCA370B20622721985B577850B0eb75', // Target recipient
    0 // batchId
  ]);
  console.log("TRANSFER", transferTx);

  const batchTx = Batch.encodeFunctionData('batchAll', [
    [WRAPPED_FTM_ADDRESS, XLABS_RELAYER_ADDRESS],
    [0, 0],
    [approveTx, transferTx],
    [150000, 300000] // put the gas estimates here, best to use eth_estimateGas
  ]);

  // Create the ethereumXCM extrinsic that uses the batch precompile
  const batchXCMTx = alphaAPI.tx.ethereumXcm.transact({
    V1: {
      gasLimit: new BN(400000),
      feePayment: 'Auto',
      action: {
        Call: BATCH_PRECOMPILE_ADDRESS
      },
      value: new BN(0),
      input: batchTx // Hex encoded input
    }
  });
  console.log("===============================================");
  console.log("Batched XLabs EVM Tx:", batchXCMTx.method.toHex());

  return batchXCMTx;
}

main();