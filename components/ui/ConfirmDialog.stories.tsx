import type { Meta, StoryObj } from "@storybook/react";
import { ConfirmDialog } from "./ConfirmDialog";

const meta: Meta<typeof ConfirmDialog> = {
  title: "UI / ConfirmDialog",
  component: ConfirmDialog,
  parameters: {
    layout: "fullscreen",
  },
  args: {
    open: true,
    onCancel: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof ConfirmDialog>;

export const LinearProjectExists: Story = {
  args: {
    title: "This spec is already a Linear project",
    body: (
      <>
        <strong>Onboarding redesign</strong> has 6 issues in{" "}
        <strong>Engineering</strong>. What should we do?
      </>
    ),
    primaryAction: {
      label: "Update existing project",
      onClick: () => {},
      subtext:
        "6 issues will be updated. Removed stories will be archived — assignees are not notified.",
    },
    secondaryAction: {
      label: "Create new project",
      onClick: () => {},
      subtext: "The existing project stays in Linear untouched.",
    },
  },
};

export const ContinueFirstPush: Story = {
  args: {
    title: "Continue the first push?",
    body: (
      <>
        <strong>Onboarding redesign</strong> exists in Linear but no issues have
        been created yet (a prior push failed partway through).
      </>
    ),
    primaryAction: {
      label: "Continue first push",
      onClick: () => {},
      subtext: "6 issues will be created in the existing empty project.",
    },
  },
};

export const InFlightIndeterminate: Story = {
  args: {
    title: "This spec is already a Linear project",
    body: (
      <>
        <strong>Onboarding redesign</strong> has 6 issues in{" "}
        <strong>Engineering</strong>.
      </>
    ),
    primaryAction: {
      label: "Update existing project",
      onClick: () => {},
    },
    inFlight: { label: "Updating project" },
  },
};

export const InFlightWithProgress: Story = {
  args: {
    title: "This spec is already a Linear project",
    body: (
      <>
        <strong>Onboarding redesign</strong> has 6 issues in{" "}
        <strong>Engineering</strong>.
      </>
    ),
    primaryAction: {
      label: "Update existing project",
      onClick: () => {},
    },
    inFlight: { label: "Updating project", progress: { completed: 3, total: 7 } },
  },
};
