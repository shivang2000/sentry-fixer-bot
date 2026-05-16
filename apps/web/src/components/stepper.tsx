import { Check } from "lucide-react";

export type StepperStep = {
  id: string;
  label: string;
  done: boolean;
};

type Props = {
  steps: StepperStep[];
  currentId?: string;
};

/**
 * Horizontal stepper. Each step is a numbered circle joined by a
 * connector line. Filled when `done`, pulsing when it matches
 * `currentId`, hollow otherwise.
 */
export function Stepper({ steps, currentId }: Props) {
  return (
    <ol className="flex w-full items-start justify-between gap-2">
      {steps.map((step, idx) => {
        const isCurrent = step.id === currentId;
        const isLast = idx === steps.length - 1;
        return (
          <li key={step.id} className="flex flex-1 items-start">
            <div className="flex flex-1 flex-col items-center gap-1.5">
              <div
                className={
                  step.done
                    ? "flex h-8 w-8 items-center justify-center rounded-full bg-emerald-500 text-white"
                    : isCurrent
                      ? "flex h-8 w-8 animate-pulse items-center justify-center rounded-full border-2 border-indigo-400 bg-indigo-500/10 text-indigo-300"
                      : "flex h-8 w-8 items-center justify-center rounded-full border-2 border-zinc-700 bg-zinc-900 text-zinc-500"
                }
              >
                {step.done ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <span className="text-xs">{idx + 1}</span>
                )}
              </div>
              <span
                className={
                  step.done
                    ? "text-center text-emerald-300 text-xs"
                    : isCurrent
                      ? "text-center text-indigo-200 text-xs"
                      : "text-center text-xs text-zinc-500"
                }
              >
                {step.label}
              </span>
            </div>
            {!isLast ? (
              <div
                className={
                  step.done
                    ? "mt-4 h-0.5 flex-1 bg-emerald-500/60"
                    : "mt-4 h-0.5 flex-1 bg-zinc-800"
                }
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
