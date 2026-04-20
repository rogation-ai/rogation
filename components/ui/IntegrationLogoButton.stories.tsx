import type { Meta, StoryObj } from "@storybook/react";
import {
  IntegrationLogoButton,
  type IntegrationProvider,
} from "./IntegrationLogoButton";

const meta: Meta<typeof IntegrationLogoButton> = {
  title: "UI / IntegrationLogoButton",
  component: IntegrationLogoButton,
};

export default meta;
type Story = StoryObj<typeof IntegrationLogoButton>;

const ALL: IntegrationProvider[] = [
  "linear",
  "notion",
  "zendesk",
  "posthog",
  "canny",
];

export const Linear: Story = { args: { provider: "linear" } };
export const Connected: Story = { args: { provider: "linear", connected: true } };
export const Disabled: Story = { args: { provider: "notion", disabled: true } };

export const AllProviders: Story = {
  render: () => (
    <div className="flex flex-wrap gap-3">
      {ALL.map((p) => (
        <IntegrationLogoButton key={p} provider={p} />
      ))}
    </div>
  ),
};

export const MixedStates: Story = {
  render: () => (
    <div className="flex flex-wrap gap-3">
      <IntegrationLogoButton provider="linear" connected />
      <IntegrationLogoButton provider="zendesk" />
      <IntegrationLogoButton provider="notion" disabled />
      <IntegrationLogoButton provider="posthog" />
      <IntegrationLogoButton provider="canny" disabled />
    </div>
  ),
};
