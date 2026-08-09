import { describeFailure } from './failures';
import type { ApiClient, RequestOptions } from './api';
import type { TerminalSummary, TerminalsResponse, TillSettings } from './api-types';
import type { Failure } from './failures';

/**
 * Which till this browser is.
 *
 * The list comes from the server, scoped to the branch the session belongs to;
 * the browser cannot ask about another branch and does not try. What is
 * decided here is only which of the offered tills the cashier is standing at —
 * device context, not authority. The server revalidates the id on every shift
 * and every sale regardless of what is remembered here.
 *
 * The same response carries the tenant's price mode, because the till has to
 * render a total the server will agree with and has no other lawful way to
 * learn it.
 */

export type TerminalState =
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'choosing';
      readonly terminals: readonly TerminalSummary[];
      readonly settings: TillSettings;
    }
  | { readonly kind: 'chosen'; readonly terminal: TerminalSummary; readonly settings: TillSettings }
  | { readonly kind: 'blocked'; readonly failure: Failure };

export const initialTerminalState: TerminalState = { kind: 'loading' };

const NONE_CONFIGURED: Failure = {
  code: 'no_terminals',
  message: 'لا يوجد صندوق مفعّل في هذا الفرع. أضف صندوقاً من إعدادات المنشأة قبل البيع.',
  action: 'blocking',
};

/**
 * Turn the server's answer into a state.
 *
 * One till is chosen for the cashier, because presenting a list of one is a
 * question with no information in it. A remembered id is honoured only if the
 * server still offers it — a till that was deactivated must not be selectable
 * because this browser saw it yesterday.
 */
export function chooseTerminal(
  response: TerminalsResponse,
  remembered: string | null,
): TerminalState {
  const terminals = response.terminals;
  const settings = response.settings;
  if (terminals.length === 0) return { kind: 'blocked', failure: NONE_CONFIGURED };

  const recalled = terminals.find((terminal) => terminal.id === remembered);
  if (recalled !== undefined) return { kind: 'chosen', terminal: recalled, settings };

  const only = terminals.length === 1 ? terminals[0] : undefined;
  if (only !== undefined) return { kind: 'chosen', terminal: only, settings };

  return { kind: 'choosing', terminals, settings };
}

export async function loadTerminals(
  api: ApiClient,
  remembered: string | null,
  options?: RequestOptions,
): Promise<TerminalState> {
  try {
    return chooseTerminal(await api.terminals(options), remembered);
  } catch (error) {
    return { kind: 'blocked', failure: describeFailure(error) };
  }
}
