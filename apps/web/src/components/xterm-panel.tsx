import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

export type XtermPanelHandle = {
  write: (data: string) => void;
  writeln: (data: string) => void;
  clear: () => void;
  fit: () => void;
  focus: () => void;
  size: () => { cols: number; rows: number };
};

type Props = {
  className?: string;
  onInput?: (data: string) => void;
  initialBanner?: string;
  rows?: number;
};

export const XtermPanel = forwardRef<XtermPanelHandle, Props>(function XtermPanel(
  { className, onInput, initialBanner, rows = 20 },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      fontFamily: "ui-monospace, 'JetBrains Mono', 'Menlo', monospace",
      fontSize: 13,
      theme: {
        background: "#0a0a0a",
        foreground: "#e5e5e5",
        cursor: "#22c55e",
        black: "#0a0a0a",
        red: "#ef4444",
        green: "#22c55e",
        yellow: "#eab308",
        blue: "#3b82f6",
        magenta: "#a855f7",
        cyan: "#06b6d4",
        white: "#e5e5e5",
      },
      cursorBlink: true,
      convertEol: true,
      scrollback: 5000,
      rows,
      allowTransparency: false,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);

    try {
      fitAddon.fit();
    } catch {
      // Fit can throw before layout settles; safe to ignore on first paint.
    }

    if (initialBanner) {
      term.write(initialBanner);
    }

    const onInputHandler = onInput;
    if (onInputHandler) {
      term.onData((data) => onInputHandler(data));
    }

    const onResize = () => {
      try {
        fitAddon.fit();
      } catch {
        // ignore transient resize errors
      }
    };
    window.addEventListener("resize", onResize);

    termRef.current = term;
    fitRef.current = fitAddon;

    return () => {
      window.removeEventListener("resize", onResize);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [initialBanner, onInput, rows]);

  useImperativeHandle(
    ref,
    () => ({
      write: (data: string) => termRef.current?.write(data),
      writeln: (data: string) => termRef.current?.writeln(data),
      clear: () => termRef.current?.clear(),
      fit: () => {
        try {
          fitRef.current?.fit();
        } catch {
          // ignore
        }
      },
      focus: () => termRef.current?.focus(),
      size: () => ({
        cols: termRef.current?.cols ?? 80,
        rows: termRef.current?.rows ?? 24,
      }),
    }),
    [],
  );

  return (
    <div
      ref={containerRef}
      className={
        className ?? "w-full overflow-hidden rounded-md border border-zinc-800 bg-[#0a0a0a] p-2"
      }
    />
  );
});
