import type { Meta, StoryObj } from "@storybook/react";
import { EmptyState } from "./EmptyState";

const meta: Meta<typeof EmptyState> = {
  title: "UI / EmptyState",
  component: EmptyState,
};

export default meta;
type Story = StoryObj<typeof EmptyState>;

export const EvidenceLibraryEmpty: Story = {
  args: {
    title: "Upload evidence to get started",
    description:
      "Drop interview transcripts, paste support tickets, or connect Zendesk / PostHog / Canny. Rogation clusters them into insights in about 90 seconds.",
    primaryAction: { label: "Upload files", onClick: () => {} },
    secondaryAction: { label: "Use sample data", onClick: () => {} },
  },
};

export const InsightsThinCorpus: Story = {
  args: {
    title: "Need a few more pieces",
    description:
      "Clusters get sharper around 10+ evidence rows. You have 4. Add more or load sample data to see the full flow.",
    primaryAction: { label: "Upload more", onClick: () => {} },
    secondaryAction: { label: "Use sample data", onClick: () => {} },
  },
};

export const OpportunitiesEmpty: Story = {
  args: {
    title: "Ship a cluster first",
    description:
      "Opportunities draw from your insight clusters. Head back to Insights and turn one into a spec.",
    primaryAction: { label: "Back to Insights", href: "#" },
  },
};
