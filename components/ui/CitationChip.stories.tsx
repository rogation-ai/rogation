import type { Meta, StoryObj } from "@storybook/react";
import { CitationChip } from "./CitationChip";

const meta: Meta<typeof CitationChip> = {
  title: "UI / CitationChip",
  component: CitationChip,
};

export default meta;
type Story = StoryObj<typeof CitationChip>;

export const Default: Story = {
  args: {
    clusterId: "00000000-0000-0000-0000-000000000001",
    title: "Onboarding is confusing",
    severity: "high",
    note: "Multiple users bounced on empty-state.",
  },
};

export const Critical: Story = {
  args: {
    clusterId: "00000000-0000-0000-0000-000000000002",
    title: "Share links expire after 30 days",
    severity: "critical",
    note: "Exec share-link broken mid-review; churn risk.",
  },
};

export const LongTitle: Story = {
  args: {
    clusterId: "00000000-0000-0000-0000-000000000003",
    title:
      "Mobile dashboard search lag persists across every iPhone / iPad model tested since iOS 16",
    severity: "medium",
  },
};

export const Unresolved: Story = {
  args: {
    clusterId: "00000000-0000-0000-0000-000000000004",
    title: null,
    note: "Cluster got merged away in the last re-cluster run.",
  },
};

export const Row: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      <CitationChip
        clusterId="id1"
        title="Onboarding is confusing"
        severity="high"
      />
      <CitationChip
        clusterId="id2"
        title="CSV export loses the last column"
        severity="medium"
      />
      <CitationChip clusterId="id3" title={null} />
    </div>
  ),
};
