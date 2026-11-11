import { Button } from "../../../../components/ui";

/** How long a read may take before the page says it is slow. */
export const SLOW_AFTER_MS = 8000;

/** Grey bars where the tabs and the first rules will be. */
export function PermissionsSkeleton({
  slow,
  onRetry,
}: {
  slow: boolean;
  onRetry: () => void;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy={!slow}
      data-testid="permissions-loading"
      className="flex flex-col gap-2"
    >
      <span className="sr-only">Reading your permission rules</span>
      <div className="flex flex-wrap gap-1" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="h-6 w-16 animate-pulse rounded-sm bg-lightgray/20"
          />
        ))}
      </div>
      <div className="flex flex-col gap-1" aria-hidden="true">
        <div className="h-3 w-3/4 animate-pulse rounded-sm bg-lightgray/20" />
        <div className="h-8 w-full animate-pulse rounded-sm bg-lightgray/20" />
        <div className="h-8 w-full animate-pulse rounded-sm bg-lightgray/20" />
      </div>
      {slow && (
        <div data-testid="permissions-slow" className="text-xs">
          <p className="my-1">
            Reading your rules is taking longer than usual. They come from
            config.yaml and permissions.yaml.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={onRetry}
            data-testid="permissions-retry"
          >
            Try again
          </Button>
        </div>
      )}
    </div>
  );
}

/** The read failed outright: say so, name the files and offer Retry. */
export function PermissionsError({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      role="alert"
      data-testid="permissions-error"
      className="flex flex-col items-start gap-1 rounded-sm border border-solid border-error px-2 py-1 text-xs"
    >
      <span>
        The rules could not be read. They come from config.yaml and
        permissions.yaml. This is not an empty list: nothing was loaded.
      </span>
      <Button
        variant="outline"
        size="sm"
        onClick={onRetry}
        data-testid="permissions-retry"
      >
        Retry
      </Button>
    </div>
  );
}
