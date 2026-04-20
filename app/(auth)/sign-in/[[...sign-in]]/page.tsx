import { SignIn } from "@clerk/nextjs";
import { clerkAppearance } from "../../clerk-appearance";

export const metadata = {
  title: "Sign in · Rogation",
};

export default function SignInPage() {
  return (
    <SignIn
      appearance={clerkAppearance}
      signUpUrl="/sign-up"
      fallbackRedirectUrl="/app"
    />
  );
}
