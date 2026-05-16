import { createFileRoute, redirect } from "@tanstack/react-router";

// The bot's primary surface is the kiosk chat — landing on `/` should
// drop the operator straight into a claude session. Dashboard /
// settings remain reachable from the sidebar.
export const Route = createFileRoute("/")({
  beforeLoad: () => {
    throw redirect({ to: "/chat" });
  },
  component: () => null,
});
