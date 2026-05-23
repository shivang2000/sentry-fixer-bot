import { Button } from "@sentry-fixer-bot/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@sentry-fixer-bot/ui/components/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@sentry-fixer-bot/ui/components/sidebar";
import { Skeleton } from "@sentry-fixer-bot/ui/components/skeleton";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  Activity,
  Bot,
  Database,
  History,
  Home,
  LayoutDashboard,
  LogOut,
  MessageSquareCode,
  Moon,
  Plug,
  Settings,
  Sparkles,
  Stethoscope,
  Sun,
  Zap,
} from "lucide-react";
import { useTheme } from "@/components/theme-provider";
import { authClient } from "@/lib/auth-client";

// P6 reorg: /triggers is the new primary entry point — operators
// configure triggers, not repos directly. /repos drops down to the
// Operate group so the surface is still reachable for repo-level
// config (test command, daily cap), but it isn't where new users land.
const NAV_PRIMARY = [
  { to: "/", label: "Home", icon: Home },
  { to: "/triggers", label: "Triggers", icon: Zap },
  { to: "/runs", label: "Runs", icon: History },
  { to: "/chat", label: "Chat", icon: MessageSquareCode },
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
] as const;

const NAV_OPERATE = [
  { to: "/mcps", label: "MCPs", icon: Plug },
  { to: "/skills", label: "Skills", icon: Sparkles },
  { to: "/repos", label: "Repos", icon: Database },
] as const;

const NAV_OBSERVE = [{ to: "/usage", label: "Usage", icon: Activity }] as const;

const NAV_SYSTEM = [
  { to: "/doctor", label: "Doctor", icon: Stethoscope },
  { to: "/settings", label: "Settings", icon: Settings },
] as const;

function NavGroup({
  label,
  items,
  pathname,
}: {
  label: string;
  items: ReadonlyArray<{ to: string; label: string; icon: typeof Home }>;
  pathname: string;
}) {
  return (
    <SidebarGroup>
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map(({ to, label, icon: Icon }) => {
            const isActive = pathname === to || (to !== "/" && pathname.startsWith(to));
            return (
              <SidebarMenuItem key={to}>
                <SidebarMenuButton render={<Link to={to} />} isActive={isActive} tooltip={label}>
                  <Icon className="h-4 w-4" />
                  <span>{label}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function ThemeMenu() {
  const { setTheme } = useTheme();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon" />}>
        <Sun className="h-[1.1rem] w-[1.1rem] rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
        <Moon className="absolute h-[1.1rem] w-[1.1rem] rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
        <span className="sr-only">Toggle theme</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => setTheme("light")}>Light</DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme("dark")}>Dark</DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme("system")}>System</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function UserBlock() {
  const navigate = useNavigate();
  const { data: session, isPending } = authClient.useSession();

  if (isPending) {
    return <Skeleton className="h-9 w-full" />;
  }

  if (!session) {
    return (
      <Link to="/login">
        <Button variant="outline" size="sm" className="w-full">
          Sign in
        </Button>
      </Link>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" className="w-full justify-start gap-2 px-2" />}
      >
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-zinc-800 text-xs text-zinc-200">
          {session.user.name?.slice(0, 1)?.toUpperCase() ?? "?"}
        </div>
        <div className="flex flex-col items-start text-left">
          <span className="truncate text-sm leading-tight">{session.user.name}</span>
          <span className="truncate text-xs text-zinc-500 leading-tight">{session.user.email}</span>
        </div>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Signed in</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled>{session.user.email}</DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            onClick={() =>
              authClient.signOut({
                fetchOptions: {
                  onSuccess: () => navigate({ to: "/" }),
                },
              })
            }
          >
            <LogOut className="mr-2 h-4 w-4" />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AppSidebar() {
  const { location } = useRouterState();
  const pathname = location.pathname;

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 py-1">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-indigo-600 text-white">
            <Bot className="h-4 w-4" />
          </div>
          <div className="flex flex-col leading-tight">
            <span className="font-semibold text-sm">sentry-fixer-bot</span>
            <span className="text-[10px] text-zinc-500">v2 admin</span>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <NavGroup label="Overview" items={NAV_PRIMARY} pathname={pathname} />
        <NavGroup label="Operate" items={NAV_OPERATE} pathname={pathname} />
        <NavGroup label="Observe" items={NAV_OBSERVE} pathname={pathname} />
        <NavGroup label="System" items={NAV_SYSTEM} pathname={pathname} />
      </SidebarContent>
      <SidebarFooter>
        <div className="flex items-center justify-between gap-2 px-1">
          <div className="flex-1">
            <UserBlock />
          </div>
          <ThemeMenu />
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
