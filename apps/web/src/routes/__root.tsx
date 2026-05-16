import { Separator } from "@sentry-fixer-bot/ui/components/separator";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@sentry-fixer-bot/ui/components/sidebar";
import { Toaster } from "@sentry-fixer-bot/ui/components/sonner";
import type { QueryClient } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import {
  createRootRouteWithContext,
  HeadContent,
  Outlet,
  useRouterState,
} from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";

import { AppSidebar } from "@/components/app-sidebar";
import { ThemeProvider } from "@/components/theme-provider";
import type { trpc } from "@/utils/trpc";

import "../index.css";

export interface RouterAppContext {
  trpc: typeof trpc;
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterAppContext>()({
  component: RootComponent,
  head: () => ({
    meta: [
      { title: "sentry-fixer-bot" },
      { name: "description", content: "sentry-fixer-bot — V2 admin" },
    ],
    links: [{ rel: "icon", href: "/favicon.ico" }],
  }),
});

const BARE_ROUTES = new Set<string>(["/login"]);

function RootComponent() {
  const { location } = useRouterState();
  const isBare = BARE_ROUTES.has(location.pathname);

  if (isBare) {
    return (
      <>
        <HeadContent />
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          disableTransitionOnChange
          storageKey="vite-ui-theme"
        >
          <Outlet />
          <Toaster richColors />
        </ThemeProvider>
        <TanStackRouterDevtools position="bottom-left" />
        <ReactQueryDevtools position="bottom" buttonPosition="bottom-right" />
      </>
    );
  }

  return (
    <>
      <HeadContent />
      <ThemeProvider
        attribute="class"
        defaultTheme="dark"
        disableTransitionOnChange
        storageKey="vite-ui-theme"
      >
        <SidebarProvider>
          <AppSidebar />
          <SidebarInset>
            <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-background/80 px-3 backdrop-blur">
              <SidebarTrigger />
              <Separator orientation="vertical" className="h-4" />
              <RouteBreadcrumb pathname={location.pathname} />
            </header>
            <main className="flex-1 overflow-auto">
              <Outlet />
            </main>
          </SidebarInset>
        </SidebarProvider>
        <Toaster richColors />
      </ThemeProvider>
      <TanStackRouterDevtools position="bottom-left" />
      <ReactQueryDevtools position="bottom" buttonPosition="bottom-right" />
    </>
  );
}

function RouteBreadcrumb({ pathname }: { pathname: string }) {
  const segments = pathname.split("/").filter(Boolean);
  const label = segments.length === 0 ? "Home" : segments[0]!.replace(/-/g, " ");
  return <span className="text-sm text-zinc-400 capitalize">{label}</span>;
}
