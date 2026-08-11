export interface MailDocument {
  resourceId: string;
  mailbox: string;
  internetMessageId: string | null;
  subject: string | null;
  fromAddress: string | null;
  fromName: string | null;
  toAddresses: string[];
  ccAddresses: string[];
  sentAt: Date | null;
  receivedAt: Date | null;
  textBody: string | null;
  htmlBody: string | null;
  headers: { key: string; line: string }[];
  attachmentCount: number;
  sizeBytes: number;
  sha256: string;
  bucket: string;
  objectKey: string;
}

export interface StoredAttachment {
  position: number;
  filename: string | null;
  contentType: string | null;
  sizeBytes: number;
  sha256: string;
  contentId: string | null;
  isInline: boolean;
  /** Set only when EXTRACT_ATTACHMENTS wrote it to the bucket as its own object. */
  bucket: string | null;
  objectKey: string | null;
}
