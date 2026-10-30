import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as CentralSkills from "../../../skills/CentralSkills.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { SkillsToolkit } from "./tools.ts";

const toFailure = (error: { readonly message: string }) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

export const layer = McpToolAccess.toLayer(SkillsToolkit, {
  t3_skill_list: McpToolAccess.reads(() =>
    CentralSkills.CentralSkills.pipe(
      Effect.flatMap((skills) => skills.list),
      Effect.mapError(toFailure),
    ),
  ),
  t3_skill_install: McpToolAccess.writes((input) =>
    CentralSkills.CentralSkills.pipe(
      Effect.flatMap((skills) =>
        skills.install({
          source: input.source,
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.replace === undefined ? {} : { replace: input.replace }),
        }),
      ),
      Effect.mapError(toFailure),
    ),
  ),
  t3_skill_remove: McpToolAccess.writes((input) =>
    CentralSkills.CentralSkills.pipe(
      Effect.flatMap((skills) => skills.remove(input.name)),
      Effect.mapError(toFailure),
    ),
  ),
});
