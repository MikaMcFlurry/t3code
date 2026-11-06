import { DesktopApprovalId, EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";

const state = vi.hoisted(() => ({ respond: vi.fn() }));

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: () => EnvironmentId.make("environment-1"),
}));
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: {
      requests: [
        {
          id: DesktopApprovalId.make("approval-1"),
          environmentId: EnvironmentId.make("environment-1"),
          threadId: ThreadId.make("thread-1"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerSessionId: "session-1",
          toolName: "click",
          arguments: { x: 4, y: 5 },
          createdAt: 1,
          expiresAt: 2,
        },
      ],
    },
    dataUpdatedAt: 1,
    error: null,
    failure: null,
    isPending: false,
    isSuccess: true,
    refresh: () => undefined,
  })) as never,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: () => state.respond,
}));

import { DesktopApprovalCoordinator } from "./DesktopApprovalCoordinator";

it("shows the exact desktop request and sends one explicit allow decision", async () => {
  state.respond.mockReset();
  state.respond.mockResolvedValue(undefined);
  await using screen = await render(<DesktopApprovalCoordinator />);

  await expect.element(screen.getByText("Allow desktop control?")).toBeInTheDocument();
  await expect.element(screen.getByText(/"x": 4/)).toBeInTheDocument();
  await expect.element(screen.getByText(/"y": 5/)).toBeInTheDocument();
  await page.getByRole("button", { name: "Allow once" }).click();

  expect(state.respond).toHaveBeenCalledTimes(1);
  expect(state.respond).toHaveBeenCalledWith({
    environmentId: EnvironmentId.make("environment-1"),
    input: {
      id: DesktopApprovalId.make("approval-1"),
      threadId: ThreadId.make("thread-1"),
      decision: "approve",
    },
  });
});

it("sends one explicit deny decision", async () => {
  state.respond.mockReset();
  state.respond.mockResolvedValue(undefined);
  await using screen = await render(<DesktopApprovalCoordinator />);

  await expect.element(screen.getByText("Allow desktop control?")).toBeInTheDocument();
  await page.getByRole("button", { name: "Deny" }).click();

  expect(state.respond).toHaveBeenCalledTimes(1);
  expect(state.respond).toHaveBeenCalledWith({
    environmentId: EnvironmentId.make("environment-1"),
    input: {
      id: DesktopApprovalId.make("approval-1"),
      threadId: ThreadId.make("thread-1"),
      decision: "deny",
    },
  });
});
