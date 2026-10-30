import {
  CentralSkillInstallSource,
  CentralSkillName,
  CentralSkillsListResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as CentralSkills from "../../../skills/CentralSkills.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const SkillListTool = Tool.make("t3_skill_list", {
  description:
    "List the central skill library. Its enabled skills reach every provider account T3 runs, so install shared skills here instead of into one account.",
  parameters: Tool.EmptyParams,
  success: CentralSkillsListResult,
  failure: OrchestratorMcpFailure,
  dependencies: [McpInvocationContext.McpInvocationContext, CentralSkills.CentralSkills],
})
  .annotate(Tool.Title, "List central skills")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const SkillInstallTool = Tool.make("t3_skill_install", {
  description:
    "Install a skill (a folder with SKILL.md) into the central library for every account: from a folder on this machine, a git URL (GitHub /tree/<ref>/<path> works), or a raw SKILL.md URL. Only install sources the user asked for.",
  parameters: Schema.Struct({
    source: CentralSkillInstallSource,
    name: Schema.optional(CentralSkillName),
    replace: Schema.optional(
      Schema.Boolean.annotate({ description: "Replace an installed skill of the same name." }),
    ),
  }),
  success: CentralSkillsListResult,
  failure: OrchestratorMcpFailure,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    CentralSkills.CentralSkills,
  ],
})
  .annotate(Tool.Title, "Install central skill")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const SkillRemoveTool = Tool.make("t3_skill_remove", {
  description: "Remove a skill from the central library and from every account it was copied to.",
  parameters: Schema.Struct({ name: CentralSkillName }),
  success: CentralSkillsListResult,
  failure: OrchestratorMcpFailure,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    CentralSkills.CentralSkills,
  ],
})
  .annotate(Tool.Title, "Remove central skill")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const SkillsToolkit = Toolkit.make(SkillListTool, SkillInstallTool, SkillRemoveTool);
