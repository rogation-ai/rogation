import { SignUp } from "@clerk/nextjs";
import { clerkAppearance } from "../../clerk-appearance";

export const metadata = {
  title: "Start free · Rogation",
};

export default function SignUpPage() {
  return (
    <SignUp
      appearance={clerkAppearance}
      signInUrl="/sign-in"
      fallbackRedirectUrl="/app"
    />
  );
}
