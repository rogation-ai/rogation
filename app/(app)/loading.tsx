import { SkeletonHeading, SkeletonList } from "@/components/ui/LoadingSkeleton";

/*
  Route-level loading fallback for every (app) page. Without this,
  clicking a sidebar link freezes on the previous page until the RSC
  payload + tRPC queries resolve — feels like the app is broken even
  when the round-trip is fast. The skeleton renders the instant the
  Link is clicked.
*/
export default function AppLoading(): React.JSX.Element {
  return (
    <section className="flex flex-col gap-6">
      <SkeletonHeading className="w-48" />
      <SkeletonList count={4} />
    </section>
  );
}
