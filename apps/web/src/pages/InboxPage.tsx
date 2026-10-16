import { TopBar } from '../components/Layout';
import { MailView } from './project/MailView';

/** Globales Postfach: dieselbe Ansicht wie im Projekt, nur ohne Projektfilter. */
export function InboxPage() {
  return (
    <>
      <TopBar title="Postfach" />
      <MailView global />
    </>
  );
}
