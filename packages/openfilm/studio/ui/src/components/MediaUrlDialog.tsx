import * as React from 'react';
import { Link2, LoaderCircle } from 'lucide-react';
import { useT } from '@/i18n';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { MediaIntakeError } from '@/web/media-intake';

const errorKey = (error: unknown): string => {
  if (!(error instanceof MediaIntakeError)) return 'media.intakeUnknown';
  return `media.intake_${error.code.replaceAll('-', '_')}`;
};

/** Official shadcn Dialog + Field form for the URL leg of passive media intake. */
export function MediaUrlDialog({
  open,
  onOpenChange,
  onImport,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImport: (url: string, name?: string) => Promise<unknown>;
}) {
  const t = useT();
  const [url, setUrl] = React.useState('');
  const [name, setName] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) { setUrl(''); setName(''); setError(null); setBusy(false); }
  }, [open]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!url.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onImport(url.trim(), name.trim() || undefined);
      onOpenChange(false);
    } catch (reason) {
      setError(t(errorKey(reason)));
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy || next) onOpenChange(next); }}>
      <DialogContent>
        <form onSubmit={submit} className="contents">
          <DialogHeader>
            <DialogTitle>{t('media.importUrlTitle')}</DialogTitle>
            <DialogDescription>{t('media.importUrlDescription')}</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={Boolean(error)}>
              <FieldLabel htmlFor="media-url">{t('media.url')}</FieldLabel>
              <Input
                id="media-url"
                type="url"
                autoComplete="off"
                spellCheck={false}
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://images.pexels.com/…"
                aria-invalid={Boolean(error)}
                disabled={busy}
                required
              />
              <FieldDescription>{t('media.urlHosts')}</FieldDescription>
              <FieldError>{error}</FieldError>
            </Field>
            <Field>
              <FieldLabel htmlFor="media-url-name">{t('media.nameOptional')}</FieldLabel>
              <Input
                id="media-url-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t('media.nameFromUrl')}
                disabled={busy}
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" disabled={busy} />}>
              {t('media.cancel')}
            </DialogClose>
            <Button type="submit" disabled={busy || !url.trim()}>
              {busy ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <Link2 data-icon="inline-start" />}
              {t(busy ? 'media.importingUrl' : 'media.importUrlAction')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
