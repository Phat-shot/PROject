import { TopBar } from '../components/Layout';
import { MailView } from './project/MailView';

/** Postfach: gibt es nur global; Projekte filtern oben. */
export function InboxPage() {
  return (
    <>
      <TopBar title="Postfach" />
      <MailView />
    </>
  );
}
