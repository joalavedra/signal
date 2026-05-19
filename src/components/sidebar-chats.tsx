"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { SafeLink } from "@/components/safe-link";
import { Loader2, MessageCircle } from "lucide-react";
import { listChats, type ChatSummary } from "@/lib/services/chat-history";
import { createClient } from "@/lib/supabase/client";
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

const PREVIEW_LIMIT = 8;

export function SidebarChats() {
  const pathname = usePathname();
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    const fetchChats = async () => {
      const supabase = createClient();
      const data = await listChats(supabase, PREVIEW_LIMIT);
      if (mountedRef.current) {
        setChats(data);
        setLoading(false);
      }
    };

    fetchChats();
    // Pick up newly-created chats from any tab without a page reload.
    const interval = setInterval(fetchChats, 10000);
    return () => {
      mountedRef.current = false;
      clearInterval(interval);
    };
  }, [pathname]);

  const activeChatId = pathname?.startsWith("/chat/")
    ? pathname.split("/")[2]
    : null;

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Recent chats</SidebarGroupLabel>
      <SidebarGroupAction
        render={
          <SafeLink
            href="/chat"
            aria-label="See all chats"
            className="text-muted-foreground hover:text-foreground text-xs"
          >
            See all
          </SafeLink>
        }
      />
      <SidebarGroupContent>
        <SidebarMenu>
          {loading && (
            <SidebarMenuItem>
              <SidebarMenuButton disabled>
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Loading...</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}

          {!loading && chats.length === 0 && (
            <SidebarMenuItem>
              <SidebarMenuButton
                render={<SafeLink href="/chat" />}
                tooltip="Start your first chat"
                className="text-muted-foreground"
              >
                <MessageCircle className="h-4 w-4" />
                <span className="text-xs">No chats yet</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}

          {chats.map((chat) => (
            <SidebarMenuItem key={chat.id}>
              <SidebarMenuButton
                isActive={activeChatId === chat.id}
                render={<SafeLink href={`/chat/${chat.id}`} />}
                tooltip={chat.title}
              >
                <MessageCircle className="h-4 w-4" />
                <span className="truncate">{chat.title}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
