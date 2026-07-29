
export function LoadingState({ message = "Loading..." }: { message?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16" aria-live="polite" aria-busy="true">
      <div className="w-8 h-8 border-2 border-primary/30 border-t-primary rounded-full animate-spin mb-4" role="status" />
      <span className="text-sm text-muted-foreground">{message}</span>
    </div>
  );
}
