import type { Meta, StoryObj } from "@storybook/react";
import { ReadinessGrade } from "./ReadinessGrade";

const meta: Meta<typeof ReadinessGrade> = {
  title: "UI / ReadinessGrade",
  component: ReadinessGrade,
};

export default meta;
type Story = StoryObj<typeof ReadinessGrade>;

export const A: Story = {
  args: {
    grade: "A",
    checklist: {
      edgesCovered: true,
      validationSpecified: true,
      nonFunctionalAddressed: true,
      acceptanceTestable: true,
    },
  },
};

export const B: Story = {
  args: {
    grade: "B",
    checklist: {
      edgesCovered: true,
      validationSpecified: true,
      nonFunctionalAddressed: false,
      acceptanceTestable: true,
    },
  },
};

export const C: Story = {
  args: {
    grade: "C",
    checklist: {
      edgesCovered: false,
      validationSpecified: true,
      nonFunctionalAddressed: false,
      acceptanceTestable: true,
    },
  },
};

export const D: Story = {
  args: {
    grade: "D",
    checklist: {
      edgesCovered: false,
      validationSpecified: false,
      nonFunctionalAddressed: false,
      acceptanceTestable: true,
    },
  },
};

export const Compact: Story = {
  args: {
    grade: "A",
    compact: true,
    checklist: {
      edgesCovered: true,
      validationSpecified: true,
      nonFunctionalAddressed: true,
      acceptanceTestable: true,
    },
  },
};
