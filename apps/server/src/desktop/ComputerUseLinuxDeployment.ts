import * as Layer from "effect/Layer";

import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as ComputerUseLinuxApprovalBroker from "./ComputerUseLinuxApprovalBroker.ts";
import * as ComputerUseLinuxUpstreamFactory from "./ComputerUseLinuxUpstreamFactory.ts";

/**
 * Optional deployment slice: the mediated MCP tool plus its fixed stdio process factory.
 * It uses the host's server-side approval broker. server.ts composes it on Linux only, and a
 * session reaches it only with the desktop capability, which "Agent desktop control" grants.
 */
export const layer = McpHttpServer.layerComputerUseLinuxToolkit.pipe(
  Layer.provideMerge(ComputerUseLinuxUpstreamFactory.layer),
  Layer.provide(ComputerUseLinuxApprovalBroker.layerApprovalSurface),
);
