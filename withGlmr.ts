import { ApiPromise, WsProvider } from '@polkadot/api';
import Keyring from '@polkadot/keyring';
import { BN } from "@polkadot/util";
import { createNonce } from '@certusone/wormhole-sdk';
import { ethers } from 'ethers';
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
const TOKEN_BRIDGE_ADDRESS = '0xbc976D4b9D57E57c3cA52e1Fd136C45FF7955A96';
const MLD_ACCOUNT = '0x6536B2C33B816284B97B39b2CE5bb2898dd2d9b0';

// Constants
const AMOUNT_TO_SEND = "100000000000000000";
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
      V1: [
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
                  { AccountKey20: { network: "Any", key: WRAPPED_FTM_ADDRESS } }
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
      V1: {
        parents: 1,
        interior: {
          X2: [
            { Parachain: 1000 },
            { AccountKey20: { network: "Any", key: MLD_ACCOUNT } }
          ]
        }
      }
    },
    'Unlimited' // weight limit
  );

  // Create & add ethereum tx to XCM message
  const ethereumTx = batchApproveTransferTx(alphaAPI);
  const xcmExtrinsic = betaAPI.tx.polkadotXcm.send(
    { V1: { parents: new BN(1), interior: { X1: { Parachain: 1000 } } } },
    {
      V2: [
        // Withdraw DEV asset (0.02) from the target account
        {
          WithdrawAsset: [
            {
              id: { Concrete: { parents: new BN(0), interior: { X1: { PalletInstance: BALANCE_PALLET } } } },
              fun: { Fungible: new BN("20000000000000000") }
            }
          ]
        },
        // Buy execution with the DEV asset
        {
          BuyExecution: {
            fees:
            {
              id: { Concrete: { parents: new BN(0), interior: { X1: { PalletInstance: 3 } } } },
              fun: { Fungible: new BN("20000000000000000") }
            },
            weightLimit: 'Unlimited'
          }
        },
        {
          Transact: {
            originType: "SovereignAccount",
            requireWeightAtMost: new BN("8000000000"),
            call: {
              encoded: ethereumTx.method.toHex()
            }
          }
        }
      ]
    });

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
function batchApproveTransferTx(alphaAPI: ApiPromise) {
  // Get Batch, IERC20, ITokenBridge contracts
  const Batch = new ethers.utils.Interface(abi.Batch);
  const WrappedFTM = new ethers.utils.Interface(abi.IERC20);
  const TokenBridge = new ethers.utils.Interface(abi.ITokenBridge);

  // Create contract calls & batch them
  const approveTx = WrappedFTM.encodeFunctionData("approve", [TOKEN_BRIDGE_ADDRESS, AMOUNT_TO_SEND]);
  const transferTx = TokenBridge.encodeFunctionData("transferTokens", [
    WRAPPED_FTM_ADDRESS,
    AMOUNT_TO_SEND,
    10, // Fantom Testnet
    '0x0000000000000000000000000394c0EdFcCA370B20622721985B577850B0eb75',
    0, // arbiter fee
    createNonce().readUInt32LE(0) // nonce
  ]);

  const batchTx = Batch.encodeFunctionData('batchAll', [
    [WRAPPED_FTM_ADDRESS, TOKEN_BRIDGE_ADDRESS],
    [0, 0],
    [approveTx, transferTx],
    [60000, 200000]
  ]);

  // Create the ethereumXCM extrinsic that uses the batch precompile
  const batchXCMTx = alphaAPI.tx.ethereumXcm.transact({
    V1: {
      gasLimit: new BN(280000),
      feePayment: 'Auto',
      action: {
        Call: BATCH_PRECOMPILE_ADDRESS
      },
      value: new BN(0),
      input: batchTx // Hex encoded input
    }
  });
  console.log("===============================================");
  console.log("Increment Ethereum XCM Tx:", batchXCMTx.method.toHex());
  return batchXCMTx;
}

main();