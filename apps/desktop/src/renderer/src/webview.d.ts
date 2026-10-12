import type { DetailedHTMLProps, HTMLAttributes } from 'react';

export type WebViewElement = HTMLElement & {
  reload: () => void;
};

declare global {
  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<HTMLAttributes<WebViewElement>, WebViewElement> & {
        src?: string;
        partition?: string;
        allowpopups?: boolean;
      };
    }
  }
}
