import { X } from 'lucide-react';
import { useEffect } from 'react';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}

export default function Modal({ open, onClose, title, children, size = 'md' }: ModalProps) {
  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => { document.body.style.overflow = ''; };
  }, [open]);

  if (!open) return null;

  const sizeClasses = {
    sm: 'max-w-[min(28rem,calc(100vw-2rem))]',
    md: 'max-w-[min(32rem,calc(100vw-2rem))]',
    lg: 'max-w-[min(42rem,calc(100vw-2rem))]',
    xl: 'max-w-[min(64rem,calc(100vw-2rem))]',
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-x-hidden p-4">
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div
        className={`relative flex max-h-[min(90dvh,100%)] w-full min-w-0 flex-col overflow-hidden ${sizeClasses[size]} animate-slide-up rounded-xl border bg-white shadow-2xl dark:bg-gray-900`}
      >
        <div className="flex min-w-0 items-center justify-between gap-3 border-b px-4 py-4 sm:px-6">
          <h3 className="min-w-0 truncate text-lg font-semibold text-gray-900 dark:text-white">{title}</h3>
          <button onClick={onClose} className="btn-ghost shrink-0">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-4 py-4 sm:px-6">
          {children}
        </div>
      </div>
    </div>
  );
}
