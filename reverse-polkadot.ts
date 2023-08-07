import { ApiPromise, WsProvider } from '@polkadot/api';
import Keyring from '@polkadot/keyring';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { BN } from "@polkadot/util";
import { ethers, providers } from 'ethers';
import secrets from './secrets';
import abi from './abi';
import calculateMDA from './calculateMDA';

/*
REQUIREMENTS:
1. Hold xcFTM.wh on HydraDX
2. Hold xcDEV (Alphanet's DEV) on HydraDX

CURRENT IMPLEMENTATION:

In a single transaction, batch 2 xcm transactions:
1. xTokens.transferMultiassets transaction that sends xcFTM.wh & xcDEV, which uses xcDEV as the fee currency
2. Do an xcm-ethereum transaction paid for by the xcDEV sent over from the previous step. This tx interacts with the batch precompile:
  a. Approve tokens
  b. Cross-chain transaction

*/

// Endpoints
const MB_ENDPOINT = 'wss://wss.api.moonbeam.network';
const HYDRA_ENDPOINT = 'wss://rpc.hydradx.cloud';

// Smart Contracts & Addresses
const BATCH_PRECOMPILE_ADDRESS = '0x0000000000000000000000000000000000000808';
const WRAPPED_ETH_ADDRESS = '0xab3f0245b83feb11d15aaffefd7ad465a59817ed';
const XLABS_RELAYER_ADDRESS = '0xcafd2f0a35a4459fa40c0517e17e6fa2939441ca'; // MAINNET: 0xcafd2f0a35a4459fa40c0517e17e6fa2939441ca

// Constants
const AMOUNT_TO_SEND = "1000000000000000";
const DESTINATION_CHAIN_ID = 10; // Fantom
const BALANCE_PALLET = 10; // 10 on Moonbeam, 3 on Alphanet
const MOONBEAM_PARACHAIN_ID = 2004; // 2004 on Moonbeam, 1000 on Alphanet

async function main() {
  // Wait for crypto to be loaded
  await cryptoWaitReady();

  // Create a keyring instance
  const keyring = new Keyring({ type: 'sr25519' });
  let account = keyring.addFromUri(secrets.polkadotKey);

  // Create the API interface
  const alphaWSProvider = new WsProvider(MB_ENDPOINT);
  const alphaAPI = await ApiPromise.create({ provider: alphaWSProvider });
  const hydraWSProvider = new WsProvider(HYDRA_ENDPOINT);
  const hydraAPI = await ApiPromise.create({ provider: hydraWSProvider });

  // Calculate the multilocation derivative account
  const parachainID = await hydraAPI.query.parachainInfo.parachainId();
  const MLD_ACCOUNT = await calculateMDA(account.address, parachainID.toString(), 1);

  console.log("===============================================");
  console.log("MLDA:", MLD_ACCOUNT);

  // Create transaction to send FTM and DEV, with DEV as the fee
  const sendFTMExtrinsic = hydraAPI.tx.xTokens.transferMultiassets(
    { // assets
      V3: [
        { // xcDEV
          id: {
            Concrete: {
              parents: 1,
              interior: {
                X2: [
                  { Parachain: MOONBEAM_PARACHAIN_ID },
                  { PalletInstance: BALANCE_PALLET },
                ]
              }
            }
          },
          fun: {
            Fungible: "100000000000000000",
          }
        },
        { // WETH
          id: {
            Concrete: {
              parents: 1,
              interior: {
                X3: [
                  { Parachain: MOONBEAM_PARACHAIN_ID },
                  { PalletInstance: 110 }, // 110 on MainNet, 48 on TestNet
                  { AccountKey20: { key: WRAPPED_ETH_ADDRESS } }
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
            { Parachain: MOONBEAM_PARACHAIN_ID },
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
  const xcmExtrinsic = hydraAPI.tx.polkadotXcm.send(
    { V3: { parents: new BN(1), interior: { X1: { Parachain: MOONBEAM_PARACHAIN_ID } } } },
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
              id: { Concrete: { parents: new BN(0), interior: { X1: { PalletInstance: BALANCE_PALLET } } } },
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
        {
          RefundSurplus: {}
        },
        {
          DepositAsset: {
            // Note that this must be AllCounted and not All, since All has too high of a gas requirement
            assets: { Wild: { AllCounted: 1 } },
            beneficiary: {
              parents: new BN(0),
              interior: { X1: { AccountKey20: { key: MLD_ACCOUNT } } },
            },
          },
        }
      ]
    });

  console.log("===============================================");
  console.log("Remote EVM Tx:", xcmExtrinsic.method.toHex());

  // Wrap those in a batch transaction. This transaction will:
  // 1. Send FTM + DEV together
  // 2. Use the left over DEV as the fee currency to do the wormhole route
  const batchExtrinsic = hydraAPI.tx.utility.batchAll([
    sendFTMExtrinsic,
    xcmExtrinsic,
  ]);
  console.log("===============================================");
  console.log('Batch Extrinsic:', batchExtrinsic.method.toHex());

  // Send batch transaction
  return await batchExtrinsic.signAndSend(account, ({ status }) => {
    if (status.isInBlock) {
      console.log("===============================================");
      console.log(`HydraDX transaction successful!`);
      hydraAPI.disconnect();
      alphaAPI.disconnect();
      return;
    }
  });
}

// Creates an ethereumXCM extrinsic that approves WFTM + transfers tokens
async function batchApproveTransferTx(alphaAPI: ApiPromise) {
  // Get Batch, IERC20, ITokenBridge contracts
  const Batch = new ethers.utils.Interface(abi.Batch);
  const WrappedFTM = new ethers.utils.Interface(abi.IERC20);
  // https://github.com/wormhole-foundation/example-token-bridge-relayer/blob/main/evm/src/token-bridge-relayer/TokenBridgeRelayer.sol
  const TokenRelayer = new ethers.Contract(
    XLABS_RELAYER_ADDRESS,
    abi.TokenRelayer,
    new providers.JsonRpcProvider('https://moonbeam.public.blastapi.io')
  );

  // Create contract calls & batch them
  const approveTx = WrappedFTM.encodeFunctionData("approve", [XLABS_RELAYER_ADDRESS, AMOUNT_TO_SEND]);
  console.log("APPROVE", approveTx);

  const relayerFee = await TokenRelayer.calculateRelayerFee(DESTINATION_CHAIN_ID, WRAPPED_ETH_ADDRESS, 18);
  console.log(`The relayer fee for this token will be ${relayerFee}.`); 

  // TODO: replace with wrapAndTransferEthWithRelay if is GLMR
  const transferTx = TokenRelayer.interface.encodeFunctionData("transferTokensWithRelay", [
    WRAPPED_ETH_ADDRESS,
    AMOUNT_TO_SEND,
    0, // amount of natural currency to turn into fee? Should work on testnet as long as not 0
    DESTINATION_CHAIN_ID, // Target chain, Fantom
    '0x0000000000000000000000000394c0EdFcCA370B20622721985B577850B0eb75', // Target recipient, left padded
    0 // batchId
  ]);
  console.log("TRANSFER", transferTx);

  const batchTx = Batch.encodeFunctionData('batchAll', [
    [WRAPPED_ETH_ADDRESS, XLABS_RELAYER_ADDRESS],
    [0, 0],
    [approveTx, transferTx],
    [] // put the gas estimates here, best to use eth_estimateGas
  ]);
  console.log("BATCH", batchTx)

  // Create the ethereumXCM extrinsic that uses the batch precompile
  const batchXCMTx = alphaAPI.tx.ethereumXcm.transact({
    V1: {
      gasLimit: new BN(350000),
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