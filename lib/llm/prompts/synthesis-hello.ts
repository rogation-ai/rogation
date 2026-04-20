import { definePrompt } from "@/lib/llm/prompts";

/*
  Seed prompt that proves the plumbing end-to-end without needing the
  real synthesis pipeline. It asks the model to echo a single sentence
  back in a tight JSON envelope.

  Delete this when the first real synthesis prompt lands.
*/

interface HelloInput {
  subject: string;
}

interface HelloOutput {
  greeting: string;
}

export const synthesisHello = definePrompt<HelloInput, HelloOutput>({
  name: "synthesis.hello.v1",
  task: "synthesis",
  system:
    "You respond with a JSON object of shape {\"greeting\": string}. No prose, no code fences, only JSON.",
  build(input) {
    return {
      user: `Subject: ${input.subject}\nRespond: {"greeting": "hello, <subject>"}`,
    };
  },
  parse(raw) {
    const parsed = JSON.parse(raw) as HelloOutput;
    if (typeof parsed.greeting !== "string") {
      throw new Error("hello prompt: missing greeting field");
    }
    return parsed;
  },
});
