/**
 * Subpath barrel for `@seamnex/ui/primitives`.
 *
 * Why it exists: the root barrel (`src/index.ts`) also declares the charts and the app shell,
 * so a screen that wants only `Button` and `SkeletonLines` still widens its module graph to
 * whatever those modules import. This entry is additive — the root barrel is untouched and stays
 * the canonical one — so the migration of import sites can happen screen by screen.
 *
 * Keep this list identical to the primitive block of `src/index.ts`; a name that exists in one
 * and not the other is exactly the drift this file is meant to prevent.
 */
export {
  Button,
  IconButton,
  buttonVariants,
  type ButtonProps,
  type IconButtonProps,
} from './Button';
export { Checkbox, Field, Input, Select, Switch, Textarea, type FieldProps } from './Field';
export { Badge, Kbd, StatusPill, Tag, type BadgeProps } from './Badge';
export {
  Callout,
  DefinitionList,
  Divider,
  Panel,
  PanelHeader,
  Stat,
  type DefinitionItem,
} from './Surface';
export {
  DataTable,
  KeyValueRows,
  TableToolbar,
  type Column,
  type DataTableProps,
} from './DataTable';
export { TabPanel, Tabs } from './Tabs';
export { ConfirmDialog, Dialog, Drawer } from './Overlay';
export {
  Alert,
  EmptyState,
  ErrorState,
  InlineNote,
  ProgressBar,
  Skeleton,
  SkeletonLines,
  Spinner,
  StaleNotice,
} from './Feedback';
export { Splash } from './Splash';
export { Countdown, useNow } from './Time';
export { Tooltip, TooltipProvider } from './Tooltip';
export { ErrorBoundary, isChunkLoadError } from './ErrorBoundary';
export { Stepper, type Step } from './Stepper';
export { Avatar, CopyButton, Mono, Pagination } from './Misc';
export {
  Grid,
  Page,
  SearchField,
  SplitLayout,
  type GridProps,
  type SplitLayoutProps,
} from './Layout';
export { toneBar, toneBox, toneChip, toneRow, toneText } from './tone';
