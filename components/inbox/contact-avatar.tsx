"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { avatarColor } from "@/lib/inbox";

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter((w) => /\p{L}/u.test(w));
  if (words.length === 0) return "?";
  const first = words[0][0];
  const last = words.length > 1 ? words[words.length - 1][0] : "";
  return (first + last).toUpperCase();
}

// Sem foto ainda: iniciais sobre uma cor fixa por contato. photoUrl fica pronto para a fase das fotos.
export function ContactAvatar({ name, seed, photoUrl, size = 40 }: { name: string; seed: string; photoUrl?: string | null; size?: number }) {
  const color = avatarColor(seed);
  return (
    <Avatar className="shrink-0 after:border-white/10" style={{ width: size, height: size }} aria-hidden>
      {photoUrl && <AvatarImage src={photoUrl} alt="" />}
      <AvatarFallback
        className="font-heading font-semibold tracking-wide text-white"
        style={{
          fontSize: Math.max(10, Math.round(size * 0.36)),
          background: `linear-gradient(140deg, ${color}, color-mix(in oklab, ${color} 62%, #090a0f))`,
        }}
      >
        {initials(name)}
      </AvatarFallback>
    </Avatar>
  );
}
