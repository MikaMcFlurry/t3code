import type { ProjectId } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { inferProjectTitleFromPath } from "@t3tools/client-runtime/state/projects";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { planAutoLaunch } from "@t3tools/shared/autoLaunchPlan";
import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useNowMinute } from "../../hooks/useNowMinute";
import { newProjectId } from "../../lib/utils";
import { useProjects, waitForProject } from "../../state/entities";
import { usePrimaryEnvironment } from "../../state/environments";
import { projectEnvironment } from "../../state/projects";
import { environmentServerConfigsAtom } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { newAutoProjectPath } from "./AutoLaunchDialog.logic";

const NEW_PROJECT = "__new__";

const PROFILE_LABELS = { light: "Light task", standard: "Standard task", heavy: "Heavy task" };

export function AutoLaunchDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const environment = usePrimaryEnvironment();
  const allProjects = useProjects();
  const openThread = useNewThreadHandler();
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const [prompt, setPrompt] = useState("");
  const [projectChoice, setProjectChoice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nowMinute = useNowMinute();

  const environmentId = environment?.environmentId ?? null;
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const serverConfig = environmentId ? (serverConfigs.get(environmentId) ?? null) : null;
  const projects = allProjects.filter(
    (project) => project.environmentId === environmentId && project.isScratch !== true,
  );
  const plan =
    serverConfig && prompt.trim().length > 0
      ? planAutoLaunch({
          prompt,
          projects,
          providers: serverConfig.providers,
          settings: serverConfig.settings,
          now: Date.parse(`${nowMinute}:00Z`),
        })
      : null;
  const chosen = projectChoice ?? plan?.project?.project.id ?? (plan ? NEW_PROJECT : null);
  const newProjectPath = plan ? newAutoProjectPath(projects, plan.suggestedProjectName) : null;

  const start = async () => {
    if (!plan || !environmentId || !chosen || busy) return;
    setBusy(true);
    let projectId = chosen as ProjectId;
    if (chosen === NEW_PROJECT) {
      if (!newProjectPath) {
        setBusy(false);
        return;
      }
      projectId = newProjectId();
      const created = await createProject({
        environmentId,
        input: {
          projectId,
          title: inferProjectTitleFromPath(newProjectPath),
          workspaceRoot: newProjectPath,
          createWorkspaceRootIfMissing: true,
          defaultModelSelection: null,
        },
      });
      if (created._tag === "Failure") {
        setBusy(false);
        toastManager.add({
          type: "error",
          title: "Could not create the project",
          description: String(squashAtomCommandFailure(created)),
        });
        return;
      }
      await waitForProject(scopeProjectRef(environmentId, projectId));
    }
    const opened = await openThread(scopeProjectRef(environmentId, projectId), {
      prompt: prompt.trim(),
    });
    if (opened && plan.route) {
      useComposerDraftStore.getState().setModelSelection(opened.draftId, plan.route.selection, {
        replaceOptions: true,
      });
    }
    setBusy(false);
    setPrompt("");
    setProjectChoice(null);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Auto thread</DialogTitle>
          <DialogDescription>
            Describe the task. T3 Code picks the project, model, reasoning effort and the account
            with the most usage left, then opens the draft for you to send.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3">
            <Textarea
              value={prompt}
              autoFocus
              rows={5}
              placeholder="What should be done?"
              aria-label="Task"
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void start();
              }}
            />
            {plan ? (
              <div className="flex flex-col gap-2 text-sm">
                <Select value={chosen} onValueChange={(value) => setProjectChoice(value)}>
                  <SelectTrigger size="sm" aria-label="Project">
                    <SelectValue>
                      {(value: string | null) =>
                        value === NEW_PROJECT
                          ? `New project: ${newProjectPath ?? plan.suggestedProjectName}`
                          : (projects.find((project) => project.id === value)?.title ?? "Project")
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {[
                      ...plan.ranked.map((entry) => entry.project),
                      ...projects.filter(
                        (project) => !plan.ranked.some((entry) => entry.project.id === project.id),
                      ),
                    ].map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.title}
                      </SelectItem>
                    ))}
                    <SelectItem value={NEW_PROJECT}>New project…</SelectItem>
                  </SelectPopup>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {plan.project
                    ? `Matched on: ${plan.project.matched.join(", ")}. `
                    : "No project matched, so a new one is suggested. "}
                  {PROFILE_LABELS[plan.profile]}.{" "}
                  {plan.route
                    ? `${plan.route.selection.model} · ${plan.route.reason}`
                    : "No account has usage left; the project default is used."}
                </p>
              </div>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={!plan || busy} onClick={() => void start()}>
            Open draft
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
