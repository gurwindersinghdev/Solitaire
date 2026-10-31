// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from "next/server";

const GRAPHQL_URL = "https://graphql.testnet.sui.io/graphql";

function wrapFields(val: any): any {
  if (val === null || val === undefined) return val;
  if (Array.isArray(val)) {
    return val.map(wrapFields);
  }
  if (typeof val === "object") {
    const result: any = {};
    for (const [k, v] of Object.entries(val)) {
      if (k === "id" && typeof v === "string") {
        result[k] = { id: v };
      } else if (typeof v === "object" && v !== null && !Array.isArray(v)) {
        result[k] = { fields: wrapFields(v) };
      } else {
        result[k] = wrapFields(v);
      }
    }
    return result;
  }
  return val;
}

function normalizeAddress(id: string): string {
  let address = id.toLowerCase().trim();
  if (!address.startsWith("0x")) address = "0x" + address;
  const hexPart = address.slice(2);
  if (hexPart.length < 64) {
    address = "0x" + hexPart.padStart(64, "0");
  }
  return address;
}

async function gqlQuery(query: string, variables: any = {}) {
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`GraphQL request failed: ${res.statusText}`);
  }
  return await res.json();
}

async function getObjectData(id: string) {
  const address = normalizeAddress(id);
  const query = `
    query GetObject($id: SuiAddress!) {
      object(address: $id) {
        address
        version
        digest
        owner {
          __typename
          ... on Shared { initialSharedVersion }
          ... on Immutable { __typename }
          ... on AddressOwner { address { address } }
        }
        asMoveObject {
          contents {
            type { repr }
            json
          }
        }
      }
    }
  `;
  const result = await gqlQuery(query, { id: address });
  const obj = result.data?.object;
  if (!obj) {
    return {
      error: {
        code: "notExists",
        object_id: id,
      },
      status: "NotExists",
    };
  }

  let owner: any = { Immutable: true };
  if (obj.owner?.__typename === "Shared") {
    owner = { Shared: { initial_shared_version: obj.owner.initialSharedVersion } };
  } else if (obj.owner?.__typename === "AddressOwner") {
    owner = { AddressOwner: obj.owner.address?.address };
  }

  const type = obj.asMoveObject?.contents?.type?.repr;
  const rawJson = obj.asMoveObject?.contents?.json;
  const fields = rawJson ? wrapFields(rawJson) : undefined;

  return {
    data: {
      objectId: obj.address,
      version: String(obj.version),
      digest: obj.digest,
      type,
      owner,
      content: fields
        ? {
            dataType: "moveObject",
            type,
            hasPublicTransfer: true,
            fields,
          }
        : undefined,
    },
  };
}

async function getTransactionBlock(digest: string) {
  const query = `
    query GetTx($digest: String!) {
      transaction(digest: $digest) {
        digest
        effects {
          status
          effectsJson
          events {
            nodes {
              contents {
                type { repr }
                json
              }
            }
          }
        }
      }
    }
  `;
  const result = await gqlQuery(query, { digest });
  const tx = result.data?.transaction;
  if (!tx || !tx.effects) {
    return null;
  }

  const effectsJson = tx.effects.effectsJson || {};
  const statusStr = tx.effects.status === "SUCCESS" ? "success" : "failure";

  const created: any[] = [];
  if (Array.isArray(effectsJson.changedObjects)) {
    for (const change of effectsJson.changedObjects) {
      if (change.idOperation === "CREATED") {
        created.push({
          reference: {
            objectId: change.objectId,
            version: Number(change.outputVersion || 1),
            digest: change.outputDigest || "",
          },
        });
      }
    }
  }

  const events = (tx.effects.events?.nodes || []).map((ev: any) => ({
    type: ev.contents?.type?.repr,
    parsedJson: ev.contents?.json,
  }));

  return {
    digest,
    effects: {
      status: { status: statusStr },
      created,
    },
    events,
  };
}

async function getOwnedObjects(ownerAddress: string) {
  const query = `
    query GetOwned($owner: SuiAddress!) {
      address(address: $owner) {
        objects {
          nodes {
            address
            version
            digest
            contents {
              type { repr }
              json
            }
          }
        }
      }
    }
  `;
  const result = await gqlQuery(query, { owner: normalizeAddress(ownerAddress) });
  const nodes = result.data?.address?.objects?.nodes || [];
  const data = nodes.map((n: any) => ({
    data: {
      objectId: n.address,
      version: String(n.version),
      digest: n.digest,
      type: n.contents?.type?.repr,
      content: n.contents?.json
        ? {
            dataType: "moveObject",
            type: n.contents.type?.repr,
            fields: wrapFields(n.contents.json),
          }
        : undefined,
    },
  }));

  return {
    data,
    nextCursor: null,
    hasNextPage: false,
  };
}

async function getNormalizedMoveFunction(pkg: string, mod: string, fn: string) {
  const query = `
    query GetFn($pkg: SuiAddress!, $mod: String!, $fn: String!) {
      package(address: $pkg) {
        module(name: $mod) {
          function(name: $fn) {
            parameters {
              signature
            }
          }
        }
      }
    }
  `;
  const result = await gqlQuery(query, { pkg: normalizeAddress(pkg), mod, fn });
  const parameters = result.data?.package?.module?.function?.parameters || [];
  return {
    isEntry: true,
    parameters: parameters.map((p: any) => p.signature),
    return: [],
    typeParameters: [],
    visibility: "Public",
  };
}

async function handleRpcMethod(method: string, params: any[]): Promise<any> {
  switch (method) {
    case "sui_multiGetObjects": {
      const ids: string[] = params[0] || [];
      return await Promise.all(ids.map((id) => getObjectData(id)));
    }
    case "sui_getObject": {
      const id: string = params[0];
      return await getObjectData(id);
    }
    case "suix_getReferenceGasPrice": {
      return "1000";
    }
    case "sui_getTransactionBlock": {
      const digest: string = params[0];
      return await getTransactionBlock(digest);
    }
    case "suix_getOwnedObjects": {
      const owner: string = params[0];
      return await getOwnedObjects(owner);
    }
    case "sui_getNormalizedMoveFunction": {
      const [pkg, mod, fn] = params;
      return await getNormalizedMoveFunction(pkg, mod, fn);
    }
    case "rpc.discover": {
      return { info: { title: "Sui JSON-RPC", version: "1.0.0" } };
    }
    default: {
      console.warn(`[sui-rpc] Unhandled method: ${method}`);
      return null;
    }
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    if (Array.isArray(body)) {
      const responses = await Promise.all(
        body.map(async (item) => ({
          jsonrpc: "2.0",
          id: item.id,
          result: await handleRpcMethod(item.method, item.params || []),
        }))
      );
      return NextResponse.json(responses);
    }

    const { id, method, params } = body;
    const result = await handleRpcMethod(method, params || []);

    return NextResponse.json({
      jsonrpc: "2.0",
      id,
      result,
    });
  } catch (err: any) {
    console.error("[sui-rpc] Error handling RPC request:", err);
    return NextResponse.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32603,
          message: err.message || "Internal RPC bridge error",
        },
      },
      { status: 500 }
    );
  }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 200,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Client-Sdk-Type, Client-Sdk-Version, Client-Target-Api-Version, Client-Request-Method",
    },
  });
}

