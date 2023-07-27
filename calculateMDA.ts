import { u8aToHex, hexToU8a } from "@polkadot/util";
import { decodeAddress, blake2AsU8a } from "@polkadot/util-crypto";
import { TypeRegistry } from "@polkadot/types";

async function calculateMDA(address: string, paraId: string, parents: number) {
  // Check Ethereum Address and/or Decode
  let decodedAddress: Uint8Array;
  const ethAddress = address.length === 42;
  const accType = ethAddress ? "AccountKey20" : "AccountId32";

  // Decode Address if Needed
  if (!ethAddress) {
    decodedAddress = decodeAddress(address);
  } else {
    decodedAddress = hexToU8a(address);
  }

  // Describe Family
  // https://github.com/paritytech/polkadot/blob/master/xcm/xcm-builder/src/location_conversion.rs#L96-L118
  let family = "SiblingChain";
  if (parents == 0 && paraId) family = "ChildChain";
  else if (parents == 1 && !paraId) family = "ParentChain";

  // Calculate Hash Component
  const registry = new TypeRegistry();
  let toHash = new Uint8Array([
    ...new TextEncoder().encode(family),
    ...(paraId ? registry.createType("Compact<u32>", paraId).toU8a() : []),
    ...registry.createType("Compact<u32>", accType.length + (ethAddress ? 20 : 32)).toU8a(),
    ...new TextEncoder().encode(accType),
    ...decodedAddress,
  ]);

  const DescendOriginAddress20 = u8aToHex(blake2AsU8a(toHash).slice(0, 20));
  return DescendOriginAddress20;
}

export default calculateMDA;