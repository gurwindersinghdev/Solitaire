// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0
import { SuiClient } from "@mysten/sui/client";

export const useSui = () => {
  const FULL_NODE =
    typeof window !== "undefined"
      ? `${window.location.origin}/api/sui-rpc`
      : process.env.NEXT_PUBLIC_SUI_NETWORK || "http://localhost:3000/api/sui-rpc";
  const suiClient = new SuiClient({ url: FULL_NODE });

  return { suiClient };
};
