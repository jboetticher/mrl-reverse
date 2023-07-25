// Import the keyring as required
import Keyring from '@polkadot/keyring';
import { ApiPromise, WsProvider } from '@polkadot/api';
import secrets from './secrets';
import { BN } from "@polkadot/util";
import abi from './abi';
import { ethers } from 'ethers';
import { createNonce } from '@certusone/wormhole-sdk';

/*
NEW PLAN:

In a single transaction, batch 2 transactions:
1. xTokens transaction that sends the tokens back
2. Do a transaction that interacts with the batch precompile.
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
const MLD_ACCOUNT = '0xD117eD760630549A4A8302BEC538B7b285751EcA';

const INCREMENT_ADDRESS = '0x7ab3cfcd076a3744331f8621840f1fafec75bdc7';

// Constants
const AMOUNT_TO_SEND = "100000000000000000";
const FANTOM_MULTILOCATION = {
  id: {
    Concrete: {
      parents: new BN(1), interior: {
        X3: [
          { Parachain: 1000 },
          { PalletInstance: 48 },
          { AccountKey20: { network: "Any", key: WRAPPED_FTM_ADDRESS } }
        ]
      }
    }
  },
  fun: { Fungible: new BN(AMOUNT_TO_SEND) }
};

// Create a keyring instance
const keyring = new Keyring({ type: 'ethereum' });
let account = keyring.addFromUri(secrets.privateKey);

async function main() {
  // Create the API interface
  const alphaWSProvider = new WsProvider(ALPHA_ENDPOINT);
  const alphaAPI = await ApiPromise.create({ provider: alphaWSProvider });
  const betaWSProvider = new WsProvider(BETA_ENDPOINT);
  const betaAPI = await ApiPromise.create({ provider: betaWSProvider });

  // Create & add ethereum tx to XCM message
  const ethereumTx = incrementTx(alphaAPI);
  const xcmExtrinsic = betaAPI.tx.polkadotXcm.send(
    { V3: { parents: new BN(1), interior: { X1: { Parachain: 1000 } } } },
    {
      V3: [
        // Withdraw DEV asset from the target account
        {
          WithdrawAsset: [
            {
              id: { Concrete: { parents: new BN(0), interior: { X1: { PalletInstance: 3 } } } },
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
            originKind: "SovereignAccount",
            requireWeightAtMost: { refTime: new BN("8000000000"), proofSize: 38750n },
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

  await xcmExtrinsic.signAndSend(account, ({ status }) => {
    if (status.isInBlock) {
      console.log(`Success!`);
      return;
    }
  });

  return;

  // Create transaction to send FTM
  const sendFTMExtrinsic = betaAPI.tx.xTokens.transfer(
    'SelfReserve',
    "200000000000000000",
    {
      V1: {
        parents: 1,
        interior: {
          X2: [
            { Parachain: 1000 },
            { PalletInstance: 48 },
            { AccountKey20: { network: "Any", key: WRAPPED_FTM_ADDRESS } }
          ]
        }
      }
    },
    'Unlimited'
  );

  // Wrap those in a batch transaction to also send FTM or USDC back
  const batchExtrinsic = betaAPI.tx.utility.batchAll([
    sendFTMExtrinsic,
    xcmExtrinsic,
  ]);
  console.log('Batch Extrinsic:', batchExtrinsic.method.toHex());

  // Send batch transaction
  await batchExtrinsic.signAndSend(account, ({ status }) => {
    if (status.isInBlock) {
      console.log(`Success!`);
      return;
    }
  });

  return;
}

main()

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
  console.log("Increment Ethereum XCM Tx:", batchXCMTx.method.toHex());
  return batchXCMTx;
}

// Creates an ethereumXCM extrinsic that approves a contract to transfer WFTM
function batchApproveMockTx(alphaAPI: ApiPromise) {
  // Get Batch, IERC20, ITokenBridge contracts
  const Batch = new ethers.utils.Interface(abi.Batch);
  const WrappedFTM = new ethers.utils.Interface(abi.IERC20);

  const approveTx = WrappedFTM.encodeFunctionData("approve", ["0x22511940eEF9C802Ca290261e80557293B362De0", "1000000000000000000"]);
  const TRANSFER = 0x1ab5d260;

  const batchTx = Batch.encodeFunctionData('batchAll', [
    [WRAPPED_FTM_ADDRESS, "0x22511940eEF9C802Ca290261e80557293B362De0" /*TOKEN_BRIDGE_ADDRESS*/],
    [0, 0],
    [approveTx, TRANSFER],
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
  console.log("Increment Ethereum XCM Tx:", batchXCMTx.method.toHex());
  return batchXCMTx;
}

// Creates an ethereumXCM extrinsic that increments a number in a simple contract
function incrementTx(alphaAPI: ApiPromise) {
  const incrementXCMTx = alphaAPI.tx.ethereumXcm.transact({
    V1: {
      gasLimit: new BN(100000),
      feePayment: 'Auto',
      action: {
        Call: INCREMENT_ADDRESS
      },
      value: new BN(0),
      input: '0xd09de08a' // Hex encoded input
    }
  });
  console.log("Increment Ethereum XCM Tx:", incrementXCMTx.method.toHex());
  return incrementXCMTx;
}

