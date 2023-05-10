# MRL Reverse

The point of this repository is to find a proper pathway from Parachains -> Moonbeam -> Wormhole -> Destination. 

The optimal solution would use only one relayer action: through the Wormhole relayer on the destination chain. To accomplish this, we plan on using the following pathway:  

1. User owns asset X on parachain Y
2. User batches 2 xcm messages from parachain Y to Moonbeam: 
    - Send asset X to a MultiLocation Derivative Account (MLDA) on Moonbeam
    - Remote EVM call (by MLDA) that batches the following EVM actions:
        - Approves Wormhole token bridge for use of asset X
        - Bridges asset X via token bridge
3. Wormhole relayer sends the tokens to the destination chain  

## Issues

There are two main issues with this implementation.  

### Remote Execution Fees

First, the MultiLocation Derivative Account must contain GLMR to execute the remote EVM call.  

The MultiLocation Derivative Account is a derived account that only an address on another parachain has access to through XCM, and it is this MLDA account that does the EVM transactions. But to send said transactions, the MLDA must have GLMR as the native gas currency.  

One solution to this restriction is to use a token that is sent over in the first XCM message as the fee currency, but this has yet to be tried.  

### XCM Execution Fees

Second, xcERC-20 assets cannot be used as a fee payment on Moonbeam, but a parachain's native currency currently cannot be used as a fee to make up for this issue. For example, xcUSDC.wh on Interlay cannot be used to pay for the XCM message from Interlay to Moonbeam. Neither can the native INTR token, since INTR and xcUSDC.wh are not from the same origin (reserve) and cannot be sent together (a restriction caused by the commonly used xTokens pallet).  

The easiest solution would be to update the xTokens pallet to simply allow for reserve and non-reserve assets to be sent in the same transaction.  

## Current Status

There is a pathway that works today, but it requires the user to own both asset X and xcGLMR on parachain Y. It works like so:  

1. User owns asset X and xcGLMR on parachain Y
2. User batches 2 xcm messages from parachain Y to Moonbeam: 
    - Send asset X and xcGLMR to a MultiLocation Derivative Account (MLDA) on Moonbeam, using xcGLMR as the fee currency
    - Remote EVM call (by MLDA) that batches the following EVM actions:
        - Approves Wormhole token bridge for use of asset X
        - Bridges asset X via token bridge
3. Wormhole relayer sends the tokens to the destination chain  

Interestingly enough, using xcGLMR solves the remote execution issue automatically. You can see this process in `withGlmr.ts`.