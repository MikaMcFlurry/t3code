import * as Layer from "effect/Layer";

import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as ComputerUseLinuxAvailability from "./ComputerUseLinuxAvailability.ts";
import * as ComputerUseLinuxApprovalBroker from "./ComputerUseLinuxApprovalBroker.ts";
import * as ComputerUseLinuxUpstreamFactory from "./ComputerUseLinuxUpstreamFactory.ts";

/**
 * Optional deployment slice: the mediated MCP tool plus its fixed stdio process factory.
 * It uses the host's server-side approval broker and is not merged into the production server
 * by default. The separately gated provider capability must also be enabled before an agent can
 * reach it.
 */
export const layer = McpHttpServer.layerComputerUseLinuxToolkit.pipe(
  Layer.provideMerge(ComputerUseLinuxUpstreamFactory.layer),
  Layer.provide(ComputerUseLinuxApprovalBroker.layerApprovalSurface),
);

/** Must be composed into provider-session construction only alongside `layer`. */
export const layerCapabilityEnabled = ComputerUseLinuxAvailability.layerEnabled;
