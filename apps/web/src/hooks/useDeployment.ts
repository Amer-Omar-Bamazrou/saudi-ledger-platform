/**
 * What kind of deployment the frontend is talking to (D3/D4/D7).
 *
 * 🔴 THIS IS FOR RENDERING, NEVER FOR ENFORCEMENT. The refusals are route-level
 * on the server (`lib/demoMode.ts`) and hold whatever the browser does. What
 * this hook buys is honesty in the other direction: a demo that still shows a
 * "Create an account" link and a "Scan a receipt" button is a demo that invites
 * the viewer to press things and be told no, which reads as a broken product
 * rather than a deliberately narrowed one.
 *
 * So: hide the entry point AND refuse at the route. Neither alone is enough —
 * hiding is cosmetic, and refusing alone is rude.
 */
import {
  getGetDeploymentBannerQueryKey,
  useGetDeploymentBanner,
} from "@workspace/api-client-react";

export function useDeployment() {
  const { data, isLoading } = useGetDeploymentBanner({
    query: {
      queryKey: getGetDeploymentBannerQueryKey(),
      // The reset state changes at most daily; re-checking on every window
      // focus would be noise. An hour is short enough that a wipe shows up in
      // the same session it happens.
      staleTime: 60 * 60_000,
      refetchOnWindowFocus: false,
      // A failed banner request must never look like a failed page. It is a
      // notice, not a capability.
      retry: 1,
    },
  });

  return {
    loading: isLoading,
    demoMode: data?.demoMode === true,
    messageEn: data?.messageEn ?? null,
    messageAr: data?.messageAr ?? null,
    lastResetAt: data?.lastResetAt ?? null,
  };
}
