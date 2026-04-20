import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { SegmentTag } from "./SegmentTag";

const meta: Meta<typeof SegmentTag> = {
  title: "UI / SegmentTag",
  component: SegmentTag,
};

export default meta;
type Story = StoryObj<typeof SegmentTag>;

export const Static: Story = { args: { name: "enterprise" } };
export const Active: Story = { args: { name: "mobile", active: true } };
export const LongNameTruncates: Story = {
  args: { name: "enterprise-customers-north-america" },
};

function InteractiveGroupDemo(): React.JSX.Element {
  const segments = ["enterprise", "smb", "mobile", "free-tier", "trial"];
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <div className="flex flex-wrap gap-2">
      {segments.map((s) => (
        <SegmentTag
          key={s}
          name={s}
          active={picked === s}
          onSelect={(n) => setPicked(picked === n ? null : n)}
        />
      ))}
    </div>
  );
}

export const InteractiveGroup: Story = {
  render: () => <InteractiveGroupDemo />,
};
