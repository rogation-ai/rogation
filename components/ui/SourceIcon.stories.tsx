import type { Meta, StoryObj } from "@storybook/react";
import { SourceIcon, type SourceType } from "./SourceIcon";

const meta: Meta<typeof SourceIcon> = {
  title: "UI / SourceIcon",
  component: SourceIcon,
};

export default meta;
type Story = StoryObj<typeof SourceIcon>;

const ALL: SourceType[] = [
  "upload_transcript",
  "upload_text",
  "upload_pdf",
  "upload_csv",
  "paste_ticket",
  "zendesk",
  "posthog",
  "canny",
];

export const Transcript: Story = { args: { source: "upload_transcript" } };
export const PDF: Story = { args: { source: "upload_pdf" } };
export const Zendesk: Story = { args: { source: "zendesk" } };

export const AllSources: Story = {
  render: () => (
    <div
      className="flex flex-wrap items-center gap-4"
      style={{ color: "var(--color-text-secondary)" }}
    >
      {ALL.map((s) => (
        <div key={s} className="flex items-center gap-2">
          <SourceIcon source={s} />
          <span className="text-xs">{s}</span>
        </div>
      ))}
    </div>
  ),
};

export const LargerSize: Story = {
  args: { source: "posthog", size: 24 },
};
