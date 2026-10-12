import { useVirtualizer } from "@tanstack/react-virtual";
import type { RefObject, ReactNode } from "react";

export function VirtualLogList<T>({
  items,
  itemSize,
  getKey,
  renderItem,
  listRef,
  onScroll,
  label,
}: {
  readonly items: readonly T[];
  readonly itemSize: 22 | 50;
  readonly getKey: (item: T, index: number) => string;
  readonly renderItem: (item: T, index: number) => ReactNode;
  readonly listRef: RefObject<HTMLDivElement | null>;
  readonly onScroll?: (element: HTMLDivElement) => void;
  readonly label: string;
}) {
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => itemSize,
    overscan: 24,
    initialRect: { width: 720, height: 420 },
    useFlushSync: false,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const firstItem = virtualItems[0];
  const lastItem = virtualItems.at(-1);
  const topSpace = firstItem?.start ?? 0;
  const bottomSpace = Math.max(0, virtualizer.getTotalSize() - (lastItem?.end ?? 0));

  return (
    <div
      aria-label={label}
      className="h-[min(65vh,700px)] overflow-auto rounded-lg border border-panel-line bg-[#0a0e13] p-3 font-mono text-[12px] text-panel-text [scrollbar-width:thin]"
      onScroll={(event) => onScroll?.(event.currentTarget)}
      ref={listRef}
      role="region"
      // The named scroll region must be focusable so it can be scrolled from a keyboard.
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
    >
      <div role="list">
        <svg aria-hidden="true" className="block" data-virtual-spacer="top" focusable="false" height={topSpace} width="1" />
        {virtualItems.map((virtualItem) => {
          const item = items[virtualItem.index];
          if (item === undefined) return null;
          return (
            <div
              aria-posinset={virtualItem.index + 1}
              aria-setsize={items.length}
              className={`${itemSize === 22 ? "h-[22px]" : "h-[50px]"} overflow-hidden leading-[22px]`}
              key={getKey(item, virtualItem.index)}
              role="listitem"
            >
              {renderItem(item, virtualItem.index)}
            </div>
          );
        })}
        <svg aria-hidden="true" className="block" data-virtual-spacer="bottom" focusable="false" height={bottomSpace} width="1" />
      </div>
    </div>
  );
}
