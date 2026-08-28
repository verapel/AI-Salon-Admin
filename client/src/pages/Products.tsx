import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  Camera,
  Droplets,
  FileSpreadsheet,
  FlaskConical,
  Minus,
  Package,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react';
import SearchInput from '@/components/ui/SearchInput';
import NumericInput from '@/components/ui/NumericInput';
import Modal from '@/components/ui/Modal';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import IndeterminateProgress from '@/components/ui/IndeterminateProgress';
import EmptyState from '@/components/ui/EmptyState';
import { useLanguage, type TranslationKey } from '@/context/LanguageContext';
import { useCurrency } from '@/context/CurrencyContext';
import { api, ApiError } from '@/lib/api';
import { exportProductsXlsx } from '@/lib/productExport';
import {
  categoryForProductSection,
  isProductInSection,
  isProductSection,
  type ProductSection,
} from '@/lib/productSection';
import { asAmount, formatProductExactPrice, formatProductPriceRange } from '@/lib/productFormat';
import { SALON_CURRENCIES } from '@/lib/currency';
import { numericDisplayValue, parseDecimalInput, parseIntegerInput } from '@/lib/numericInput';
import type { Product, ProductDraft, ProductImportResult, ProductStockStatus } from '@/types';

type StockFilter = 'all' | ProductStockStatus | 'purchase';

const STOCK_FILTERS: StockFilter[] = ['all', 'in_stock', 'low', 'out', 'purchase'];

const emptyForm = (currency = 'AMD') => ({
  name: '',
  brand: '',
  line: '',
  codeShade: '',
  category: '',
  quantity: '',
  minQuantity: '',
  unit: '',
  volume: '',
  percentage: '',
  price: '',
  priceMin: '',
  priceMax: '',
  currency,
  supplier: '',
  markedForPurchase: false,
});

function filterLabel(filter: StockFilter, t: (key: TranslationKey) => string) {
  if (filter === 'all') return t('products.filterAll');
  if (filter === 'purchase') return t('products.filterPurchase');
  if (filter === 'in_stock') return t('products.filterInStock');
  if (filter === 'low') return t('products.filterLow');
  return t('products.filterOut');
}

function statusLabel(status: ProductStockStatus, t: (key: TranslationKey) => string) {
  if (status === 'in_stock') return t('products.status.in_stock');
  if (status === 'low') return t('products.status.low');
  return t('products.status.out');
}

function statusBadgeClass(status: ProductStockStatus) {
  if (status === 'in_stock') {
    return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300';
  }
  if (status === 'low') {
    return 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300';
  }
  return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300';
}

export default function Products() {
  const { t } = useLanguage();
  const { currency: salonCurrency } = useCurrency();
  const [searchParams, setSearchParams] = useSearchParams();
  const rawSection = searchParams.get('section');
  const section = isProductSection(rawSection) ? rawSection : null;
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<StockFilter>('all');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [previewRows, setPreviewRows] = useState<ProductDraft[]>([]);
  const [importError, setImportError] = useState('');
  const [importResult, setImportResult] = useState<ProductImportResult | null>(null);
  const [photoProcessingOpen, setPhotoProcessingOpen] = useState(false);
  const [photoStage, setPhotoStage] = useState<'upload' | 'recognition' | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);

  const loadProducts = () => {
    api.products
      .getAll()
      .then(setProducts)
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadProducts();
  }, []);

  useEffect(() => {
    setSearch('');
    setFilter('all');
  }, [section]);

  const sectionProducts = section
    ? products.filter((product) => isProductInSection(product, section))
    : [];

  const statusFiltered =
    filter === 'all'
      ? sectionProducts
      : filter === 'purchase'
        ? sectionProducts.filter((p) => p.markedForPurchase)
        : sectionProducts.filter((p) => p.stockStatus === filter);

  const query = search.trim().toLowerCase();
  const searched = query
    ? statusFiltered.filter((product) =>
        [
          product.name,
          product.brand,
          product.line,
          product.codeShade,
          product.category,
          product.volume,
          product.supplier,
        ].some((value) => value.toLowerCase().includes(query))
      )
    : statusFiltered;

  const filtered =
    section === 'care'
      ? [...searched].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
      : searched;

  const openSection = (next: ProductSection) => {
    setSearchParams({ section: next });
    setSearch('');
    setFilter('all');
  };

  const handleSectionBack = () => {
    setSearchParams({}, { replace: true });
  };

  const openCreate = () => {
    if (!section) return;
    setEditing(null);
    setForm({ ...emptyForm(salonCurrency), category: categoryForProductSection(section) });
    setFormError('');
    setModalOpen(true);
  };

  const openEdit = (product: Product) => {
    setEditing(product);
    setForm({
      name: product.name,
      brand: product.brand,
      line: product.line,
      codeShade: product.codeShade,
      category: product.category,
      quantity: numericDisplayValue(product.quantity),
      minQuantity: numericDisplayValue(product.minQuantity),
      unit: product.unit,
      volume: product.volume ?? '',
      percentage: product.percentage == null ? '' : String(product.percentage),
      price: numericDisplayValue(product.price),
      priceMin: product.priceMin == null ? '' : String(product.priceMin),
      priceMax: product.priceMax == null ? '' : String(product.priceMax),
      currency: salonCurrency,
      supplier: product.supplier,
      markedForPurchase: product.markedForPurchase,
    });
    setFormError('');
    setModalOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setFormError('');
    try {
      const payload = {
        ...(section
          ? { ...form, category: categoryForProductSection(section, form.category) }
          : form),
        quantity: parseIntegerInput(form.quantity, 0),
        minQuantity: parseIntegerInput(form.minQuantity, 0),
        percentage: form.percentage === '' ? null : parseDecimalInput(form.percentage),
        price: parseDecimalInput(form.price) ?? 0,
        priceMin: asAmount(form.priceMin),
        priceMax: asAmount(form.priceMax),
        currency: salonCurrency,
      };
      if (editing) {
        await api.products.update(editing.id, payload);
      } else {
        await api.products.create(payload);
      }
      setModalOpen(false);
      setEditing(null);
      loadProducts();
    } catch (err) {
      if (err instanceof ApiError && (err.status === 409 || err.code === 'PRODUCT_IDENTITY_EXISTS')) {
        setFormError(t('products.duplicateIdentity'));
      } else {
        console.error(err);
        setFormError(err instanceof Error ? err.message : t('common.serverUnavailable'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm(t('products.deleteConfirm'))) return;
    if (actionBusy) return;
    setActionBusy(id);
    try {
      await api.products.delete(id);
      loadProducts();
    } catch (err) {
      console.error(err);
    } finally {
      setActionBusy(null);
    }
  };

  const handleQuantity = async (product: Product, delta: number) => {
    if (actionBusy) return;
    if (delta < 0 && product.quantity <= 0) return;
    setActionBusy(product.id);
    try {
      const updated = await api.products.adjustQuantity(product.id, delta);
      setProducts((prev) => prev.map((row) => (row.id === updated.id ? updated : row)));
    } catch (err) {
      console.error(err);
    } finally {
      setActionBusy(null);
    }
  };

  const handlePurchaseToggle = async (product: Product) => {
    if (actionBusy) return;
    setActionBusy(product.id);
    try {
      const updated = await api.products.update(product.id, {
        markedForPurchase: !product.markedForPurchase,
      });
      setProducts((prev) => prev.map((row) => (row.id === updated.id ? updated : row)));
    } catch (err) {
      console.error(err);
    } finally {
      setActionBusy(null);
    }
  };

  const readFileAsBase64 = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result ?? '');
        resolve(result.includes(',') ? result.slice(result.indexOf(',') + 1) : result);
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });

  const handleImportFile = async (file: File | undefined, kind: 'auto' | 'photo') => {
    if (!file || importBusy) return;
    setImportBusy(true);
    setImportError('');
    setImportResult(null);
    const isSpreadsheet = /\.(xlsx|xls|csv)$/i.test(file.name);
    const isPhoto = kind === 'photo' || (!isSpreadsheet && file.type.startsWith('image/'));
    if (isPhoto) {
      setPhotoProcessingOpen(true);
      setPhotoStage('upload');
    }
    try {
      if (isPhoto) {
        const contentBase64 = await readFileAsBase64(file);
        setPhotoStage('recognition');
        const payload = { filename: file.name, mimeType: file.type || 'image/jpeg', contentBase64 };
        const parsed = await api.products.parsePhoto(payload);
        setPreviewRows(parsed.rows.map((row) => ({ ...row, currency: salonCurrency })));
        setPhotoProcessingOpen(false);
        setPhotoStage(null);
        setImportOpen(true);
        if (parsed.rows.length === 0) {
          setImportError(t('products.noResults'));
        }
      } else {
        const contentBase64 = await readFileAsBase64(file);
        const payload = { filename: file.name, mimeType: file.type || 'application/octet-stream', contentBase64 };
        const parsed = await api.products.parseImport(payload);
        setPreviewRows(parsed.rows.map((row) => ({ ...row, currency: salonCurrency })));
        setImportOpen(true);
        if (parsed.rows.length === 0) {
          setImportError(t('products.noResults'));
        }
      }
    } catch (err) {
      if (isPhoto) {
        setPhotoStage(null);
        setPreviewRows([]);
        if (err instanceof ApiError) setImportError(err.message);
        else setImportError(err instanceof Error ? err.message : t('common.serverUnavailable'));
      } else {
        setImportOpen(true);
        setPreviewRows([]);
        if (err instanceof ApiError) setImportError(err.message);
        else setImportError(err instanceof Error ? err.message : t('common.serverUnavailable'));
      }
    } finally {
      setImportBusy(false);
    }
  };

  const confirmImport = async () => {
    if (importBusy) return;
    setImportBusy(true);
    setImportError('');
    try {
      const rows = section
        ? previewRows.map((row) => ({
            ...row,
            category: categoryForProductSection(section, row.category),
          }))
        : previewRows;
      const result = await api.products.commitImport(rows);
      setImportResult(result);
      loadProducts();
    } catch (err) {
      if (err instanceof ApiError) setImportError(err.message);
      else setImportError(err instanceof Error ? err.message : t('common.serverUnavailable'));
    } finally {
      setImportBusy(false);
    }
  };

  const emptyTitle =
    sectionProducts.length === 0 ? t('products.noProducts') : t('products.noResults');
  const emptyDescription =
    sectionProducts.length === 0 ? t('products.noProductsDesc') : t('products.noResultsDesc');

  if (loading) return <LoadingSpinner />;

  if (!section) {
    return (
      <div className="w-full min-w-0 max-w-full overflow-x-clip space-y-4 animate-fade-in">
        <div className="grid w-full min-w-0 grid-cols-1 gap-3 sm:grid-cols-3">
          <button
            type="button"
            onClick={() => openSection('paint')}
            className="card flex min-h-[88px] w-full min-w-0 items-start gap-3 p-4 text-left hover:shadow-card-hover sm:p-6"
          >
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand-100 text-brand-700 dark:bg-brand-900/50 dark:text-brand-300">
              <Droplets className="h-5 w-5" />
            </span>
            <span className="min-w-0">
              <span className="block font-semibold text-gray-900 dark:text-white">
                {t('products.sectionPaint')}
              </span>
              <span className="mt-1 block text-sm text-gray-500 dark:text-gray-400">
                {t('products.sectionPaintDesc')}
              </span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => openSection('oxide')}
            className="card flex min-h-[88px] w-full min-w-0 items-start gap-3 p-4 text-left hover:shadow-card-hover sm:p-6"
          >
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand-100 text-brand-700 dark:bg-brand-900/50 dark:text-brand-300">
              <FlaskConical className="h-5 w-5" />
            </span>
            <span className="min-w-0">
              <span className="block font-semibold text-gray-900 dark:text-white">
                {t('products.sectionOxide')}
              </span>
              <span className="mt-1 block text-sm text-gray-500 dark:text-gray-400">
                {t('products.sectionOxideDesc')}
              </span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => openSection('care')}
            className="card flex min-h-[88px] w-full min-w-0 items-start gap-3 p-4 text-left hover:shadow-card-hover sm:p-6"
          >
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand-100 text-brand-700 dark:bg-brand-900/50 dark:text-brand-300">
              <Sparkles className="h-5 w-5" />
            </span>
            <span className="min-w-0">
              <span className="block font-semibold text-gray-900 dark:text-white">
                {t('products.sectionCare')}
              </span>
              <span className="mt-1 block text-sm text-gray-500 dark:text-gray-400">
                {t('products.sectionCareDesc')}
              </span>
            </span>
          </button>
        </div>
      </div>
    );
  }

  const quantityControls = (product: Product, compact = false) => (
    <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={() => handleQuantity(product, -1)}
        disabled={actionBusy === product.id || product.quantity <= 0}
        className={compact ? 'btn-ghost p-1.5' : 'btn-ghost min-h-[44px] min-w-[44px] p-2'}
        aria-label={t('products.qtyDecreaseAria')}
      >
        <Minus className="h-4 w-4" />
      </button>
      <span className="min-w-[3ch] text-center tabular-nums font-medium text-gray-900 dark:text-white">
        {product.quantity}
        {product.unit ? ` ${product.unit}` : ''}
      </span>
      <button
        type="button"
        onClick={() => handleQuantity(product, 1)}
        disabled={actionBusy === product.id}
        className={compact ? 'btn-ghost p-1.5' : 'btn-ghost min-h-[44px] min-w-[44px] p-2'}
        aria-label={t('products.qtyIncreaseAria')}
      >
        <Plus className="h-4 w-4" />
      </button>
    </div>
  );

  return (
    <div className="w-full min-w-0 max-w-full overflow-x-clip space-y-4 animate-fade-in">
      <div className="flex w-full min-w-0 max-w-full flex-col gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={handleSectionBack}
            className="btn-ghost min-h-[44px] min-w-[44px] shrink-0 p-2 sm:min-h-0 sm:min-w-0"
            aria-label={t('products.sectionBack')}
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <h2 className="min-w-0 truncate text-lg font-semibold text-gray-900 dark:text-white">
            {section === 'paint'
              ? t('products.sectionPaint')
              : section === 'oxide'
                ? t('products.sectionOxide')
                : t('products.sectionCare')}
          </h2>
        </div>
        <div className="flex w-full min-w-0 max-w-full flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="w-full min-w-0 max-w-full sm:max-w-xs">
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder={t('products.searchPlaceholder')}
            />
          </div>
          <div className="flex w-full min-w-0 max-w-full flex-col gap-2 sm:w-auto sm:flex-row sm:flex-wrap sm:justify-end">
            <input
              ref={importInputRef}
              type="file"
              className="hidden"
              accept=".xlsx,.xls,.csv,image/*"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                void handleImportFile(file, 'auto');
              }}
            />
            <input
              ref={photoInputRef}
              type="file"
              className="hidden"
              accept="image/*"
              capture="environment"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                void handleImportFile(file, 'photo');
              }}
            />
            <button
              type="button"
              onClick={() => importInputRef.current?.click()}
              disabled={importBusy}
              className="btn-secondary w-full sm:w-auto"
              aria-label={t('products.importAria')}
            >
              <Upload className="h-4 w-4" /> {t('products.import')}
            </button>
            <button
              type="button"
              onClick={() => photoInputRef.current?.click()}
              disabled={importBusy}
              className="btn-secondary w-full sm:w-auto"
              aria-label={t('products.importPhotoAria')}
            >
              <Camera className="h-4 w-4" /> {t('products.addPhoto')}
            </button>
            <button
              type="button"
              onClick={() => exportProductsXlsx(filtered)}
              className="btn-secondary w-full sm:w-auto"
            >
              <FileSpreadsheet className="h-4 w-4" /> {t('products.exportExcel')}
            </button>
            <button onClick={openCreate} className="btn-primary w-full sm:w-auto">
              <Plus className="h-4 w-4" /> {t('products.add')}
            </button>
          </div>
        </div>

        <div className="flex w-full min-w-0 max-w-full flex-wrap gap-2">
          {STOCK_FILTERS.map((item) => (
            <button
              key={item}
              onClick={() => setFilter(item)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                filter === item
                  ? 'bg-brand-100 text-brand-700 dark:bg-brand-900/50 dark:text-brand-300'
                  : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
              }`}
            >
              {filterLabel(item, t)}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<Package className="h-8 w-8 text-gray-400" />}
          title={emptyTitle}
          description={emptyDescription}
          action={
            sectionProducts.length === 0 ? (
              <button onClick={openCreate} className="btn-primary">
                <Plus className="h-4 w-4" /> {t('products.add')}
              </button>
            ) : undefined
          }
        />
      ) : (
        <>
          <div className="space-y-2 sm:hidden">
            {filtered.map((product) => (
              <button
                key={product.id}
                type="button"
                onClick={() => openEdit(product)}
                className="card w-full min-w-0 max-w-full space-y-1.5 p-3 text-left"
                aria-label={t('products.editAria')}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-gray-900 dark:text-white">
                      {product.name}
                    </p>
                    <p className="truncate text-xs text-gray-500 dark:text-gray-400">
                      {[product.brand, product.line, product.codeShade].filter(Boolean).join(' · ') ||
                        '—'}
                    </p>
                  </div>
                  <span className={`badge shrink-0 px-1.5 py-0.5 text-[10px] ${statusBadgeClass(product.stockStatus)}`}>
                    {statusLabel(product.stockStatus, t)}
                  </span>
                </div>
                <div className="flex min-w-0 flex-wrap gap-x-2 gap-y-0.5 text-[11px] leading-tight text-gray-500 dark:text-gray-400">
                  {product.volume ? <span className="min-w-0 break-words">{product.volume}</span> : null}
                  {product.percentage != null ? <span>{product.percentage}%</span> : null}
                  <span className="shrink-0">{salonCurrency}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  {quantityControls(product, true)}
                  <div className="min-w-0 text-right">
                    <p className="text-sm font-semibold tabular-nums text-gray-900 dark:text-white">
                      {formatProductExactPrice(product, salonCurrency)}
                    </p>
                    <p className="text-[11px] leading-tight text-gray-500 dark:text-gray-400">
                      {formatProductPriceRange(product, salonCurrency)}
                    </p>
                  </div>
                </div>
              </button>
            ))}
          </div>

          <div className="hidden sm:block">
            <div className="card overflow-hidden p-0">
              <div className="table-scroll">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-gray-50 dark:border-gray-700 dark:bg-gray-800/50">
                      <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                        {t('products.columnProduct')}
                      </th>
                      <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                        {t('products.columnQty')}
                      </th>
                      <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                        {t('products.columnStatus')}
                      </th>
                      <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                        {t('products.columnPrice')}
                      </th>
                      <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                        {t('products.fieldPriceRange')}
                      </th>
                      <th className="px-4 py-3 text-right font-medium text-gray-500 dark:text-gray-400">
                        {t('products.columnActions')}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y dark:divide-gray-700">
                    {filtered.map((product) => (
                      <tr
                        key={product.id}
                        className="cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/30"
                        onClick={() => openEdit(product)}
                      >
                        <td className="px-4 py-3">
                          <div className="font-medium text-gray-900 dark:text-white">{product.name}</div>
                          <div className="text-xs text-gray-500 dark:text-gray-400">
                            {[product.brand, product.codeShade].filter(Boolean).join(' · ') || '—'}
                          </div>
                        </td>
                        <td className="px-4 py-3">{quantityControls(product, true)}</td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-1.5">
                            <span className={`badge ${statusBadgeClass(product.stockStatus)}`}>
                              {statusLabel(product.stockStatus, t)}
                            </span>
                            <button
                              type="button"
                              className={`badge ${
                                product.markedForPurchase
                                  ? 'bg-brand-50 text-brand-700 dark:bg-brand-950/40 dark:text-brand-300'
                                  : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400'
                              }`}
                              disabled={actionBusy === product.id}
                              onClick={(e) => {
                                e.stopPropagation();
                                void handlePurchaseToggle(product);
                              }}
                            >
                              {t('products.markedForPurchase')}
                            </button>
                          </div>
                        </td>
                        <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">
                          {formatProductExactPrice(product, salonCurrency)}
                        </td>
                        <td className="px-4 py-3 text-gray-900 dark:text-white">
                          {formatProductPriceRange(product, salonCurrency)}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                            <button
                              onClick={() => openEdit(product)}
                              disabled={actionBusy === product.id}
                              className="btn-ghost p-1.5"
                              aria-label={t('products.editAria')}
                            >
                              <Pencil className="h-4 w-4" />
                            </button>
                            <button
                              onClick={() => handleDelete(product.id)}
                              disabled={actionBusy === product.id}
                              className="btn-ghost p-1.5 text-red-500"
                              aria-label={t('products.deleteAria')}
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </>
      )}

      <Modal
        open={photoProcessingOpen}
        onClose={() => {
          if (importBusy) return;
          setPhotoProcessingOpen(false);
        }}
        title={t('products.addPhoto')}
        size="sm"
      >
        <div className="space-y-4">
          {importBusy ? (
            <IndeterminateProgress
              label={t('products.photoProcessing')}
              detail={
                photoStage === 'upload'
                  ? t('products.photoStageUpload')
                  : photoStage === 'recognition'
                    ? t('products.photoStageRecognition')
                    : undefined
              }
            />
          ) : (
            <>
              {importError ? (
                <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
                  {importError}
                </p>
              ) : null}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setPhotoProcessingOpen(false)}
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => {
                    setPhotoProcessingOpen(false);
                    setImportError('');
                    photoInputRef.current?.click();
                  }}
                >
                  {t('products.photoRetry')}
                </button>
              </div>
            </>
          )}
        </div>
      </Modal>

      <Modal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        title={importResult ? t('products.importResult') : t('products.previewTitle')}
        size="xl"
      >
        <div className="space-y-4">
          {!importResult ? <p className="text-sm text-gray-500 dark:text-gray-400">{t('products.previewHint')}</p> : null}
          {importError ? (
            <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
              {importError}
            </p>
          ) : null}
          {importResult ? (
            <div className="space-y-1 text-sm text-gray-700 dark:text-gray-300">
              <p>{t('products.resultCreated').replace('{count}', String(importResult.created))}</p>
              <p>{t('products.resultUpdated').replace('{count}', String(importResult.updated))}</p>
              <p>{t('products.resultSkipped').replace('{count}', String(importResult.skipped))}</p>
              <p>{t('products.resultErrors').replace('{count}', String(importResult.errors.length))}</p>
              {importResult.errors.length > 0 ? (
                <ul className="list-disc pl-5 text-red-600 dark:text-red-400">
                  {importResult.errors.map((item, index) => (
                    <li key={`${item.name}-${index}`}>
                      {item.name}: {item.message}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : (
            <div className="table-scroll">
              <table className="w-full min-w-[720px] max-w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-gray-500 dark:border-gray-700 dark:text-gray-400">
                    <th className="py-2 pr-2">{t('products.fieldName')}</th>
                    <th className="py-2 pr-2">{t('products.fieldBrand')}</th>
                    <th className="py-2 pr-2">{t('products.fieldLine')}</th>
                    <th className="py-2 pr-2">{t('products.fieldCodeShade')}</th>
                    <th className="py-2 pr-2">{t('products.fieldQuantity')}</th>
                    <th className="py-2 pr-2">{t('products.fieldVolume')}</th>
                    <th className="py-2 pr-2">{t('products.fieldPercentage')}</th>
                    <th className="py-2 pr-2">{t('products.fieldPrice')}</th>
                    <th className="py-2 pr-2">{t('products.fieldPriceRange')}</th>
                    <th className="py-2 pr-2">{t('products.fieldCurrency')}</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody>
                  {previewRows.map((row, index) => (
                    <tr key={index} className="border-b dark:border-gray-800">
                      <td className="py-1 pr-2">
                        <input
                          className="input-field"
                          value={row.name}
                          onChange={(e) =>
                            setPreviewRows((prev) =>
                              prev.map((item, i) => (i === index ? { ...item, name: e.target.value } : item))
                            )
                          }
                        />
                      </td>
                      <td className="py-1 pr-2">
                        <input
                          className="input-field"
                          value={row.brand}
                          onChange={(e) =>
                            setPreviewRows((prev) =>
                              prev.map((item, i) => (i === index ? { ...item, brand: e.target.value } : item))
                            )
                          }
                        />
                      </td>
                      <td className="py-1 pr-2">
                        <input
                          className="input-field"
                          value={row.line}
                          onChange={(e) =>
                            setPreviewRows((prev) =>
                              prev.map((item, i) => (i === index ? { ...item, line: e.target.value } : item))
                            )
                          }
                        />
                      </td>
                      <td className="py-1 pr-2">
                        <input
                          className="input-field"
                          value={row.codeShade}
                          onChange={(e) =>
                            setPreviewRows((prev) =>
                              prev.map((item, i) => (i === index ? { ...item, codeShade: e.target.value } : item))
                            )
                          }
                        />
                      </td>
                      <td className="py-1 pr-2">
                        <NumericInput
                          integer
                          value={numericDisplayValue(row.quantity)}
                          onChange={(next) =>
                            setPreviewRows((prev) =>
                              prev.map((item, i) =>
                                i === index ? { ...item, quantity: parseIntegerInput(next, 0) } : item
                              )
                            )
                          }
                        />
                      </td>
                      <td className="py-1 pr-2">
                        <input
                          className="input-field"
                          value={row.volume}
                          onChange={(e) =>
                            setPreviewRows((prev) =>
                              prev.map((item, i) => (i === index ? { ...item, volume: e.target.value } : item))
                            )
                          }
                        />
                      </td>
                      <td className="py-1 pr-2">
                        <NumericInput
                          value={row.percentage == null ? '' : String(row.percentage)}
                          onChange={(next) =>
                            setPreviewRows((prev) =>
                              prev.map((item, i) =>
                                i === index
                                  ? {
                                      ...item,
                                      percentage: next === '' ? null : parseDecimalInput(next),
                                    }
                                  : item
                              )
                            )
                          }
                        />
                      </td>
                      <td className="py-1 pr-2">
                        <NumericInput
                          value={numericDisplayValue(row.price)}
                          onChange={(next) =>
                            setPreviewRows((prev) =>
                              prev.map((item, i) =>
                                i === index ? { ...item, price: parseDecimalInput(next) ?? 0 } : item
                              )
                            )
                          }
                        />
                      </td>
                      <td className="py-1 pr-2">
                        <div className="flex min-w-0 gap-1">
                          <NumericInput
                            placeholder={t('products.fieldPriceMin')}
                            value={row.priceMin == null ? '' : String(row.priceMin)}
                            onChange={(next) =>
                              setPreviewRows((prev) =>
                                prev.map((item, i) =>
                                  i === index ? { ...item, priceMin: asAmount(next) } : item
                                )
                              )
                            }
                          />
                          <NumericInput
                            placeholder={t('products.fieldPriceMax')}
                            value={row.priceMax == null ? '' : String(row.priceMax)}
                            onChange={(next) =>
                              setPreviewRows((prev) =>
                                prev.map((item, i) =>
                                  i === index ? { ...item, priceMax: asAmount(next) } : item
                                )
                              )
                            }
                          />
                        </div>
                      </td>
                      <td className="py-1 pr-2">
                        <select
                          className="input-field"
                          value={row.currency || salonCurrency}
                          onChange={(e) =>
                            setPreviewRows((prev) =>
                              prev.map((item, i) =>
                                i === index ? { ...item, currency: e.target.value } : item
                              )
                            )
                          }
                        >
                          {SALON_CURRENCIES.map((code) => (
                            <option key={code} value={code}>
                              {code}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="py-1">
                        <button
                          type="button"
                          className="btn-ghost p-1.5 text-red-500"
                          aria-label={t('products.removeRow')}
                          onClick={() => setPreviewRows((prev) => prev.filter((_, i) => i !== index))}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex flex-wrap justify-end gap-2 pt-2">
            <button type="button" className="btn-secondary" onClick={() => setImportOpen(false)}>
              {t('common.cancel')}
            </button>
            {!importResult ? (
              <button
                type="button"
                className="btn-primary"
                disabled={importBusy || previewRows.length === 0}
                onClick={() => void confirmImport()}
              >
                {t('products.confirmImport')}
              </button>
            ) : null}
          </div>
        </div>
      </Modal>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? t('products.editTitle') : t('products.createTitle')}
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium">{t('products.fieldName')}</label>
            <input
              className="input-field"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-sm font-medium">{t('products.fieldBrand')}</label>
              <input
                className="input-field"
                value={form.brand}
                onChange={(e) => setForm({ ...form, brand: e.target.value })}
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium">{t('products.fieldLine')}</label>
              <input
                className="input-field"
                value={form.line}
                onChange={(e) => setForm({ ...form, line: e.target.value })}
              />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-sm font-medium">{t('products.fieldCodeShade')}</label>
              <input
                className="input-field"
                value={form.codeShade}
                onChange={(e) => setForm({ ...form, codeShade: e.target.value })}
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium">{t('products.fieldCategory')}</label>
              <input
                className="input-field"
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
              />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label className="mb-1.5 block text-sm font-medium">{t('products.fieldQuantity')}</label>
              <NumericInput
                integer
                value={form.quantity}
                onChange={(quantity) => setForm({ ...form, quantity })}
                placeholder="0"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium">{t('products.fieldMinQuantity')}</label>
              <NumericInput
                integer
                value={form.minQuantity}
                onChange={(minQuantity) => setForm({ ...form, minQuantity })}
                placeholder="0"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium">{t('products.fieldUnit')}</label>
              <input
                className="input-field"
                value={form.unit}
                onChange={(e) => setForm({ ...form, unit: e.target.value })}
                placeholder={t('products.unitPlaceholder')}
              />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-sm font-medium">{t('products.fieldVolume')}</label>
              <input
                className="input-field"
                value={form.volume}
                onChange={(e) => setForm({ ...form, volume: e.target.value })}
                placeholder="100 ml, 250 ml, 1 L"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium">{t('products.fieldPercentage')}</label>
              <NumericInput
                value={form.percentage}
                onChange={(percentage) => setForm({ ...form, percentage })}
                placeholder="1.5, 3, 6, 9, 12"
              />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-sm font-medium">{t('products.fieldPrice')}</label>
              <NumericInput
                value={form.price}
                onChange={(price) => setForm({ ...form, price })}
                placeholder="0"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium">{t('products.fieldPriceRange')}</label>
              <div className="grid grid-cols-2 gap-2">
                <NumericInput
                  placeholder={t('products.fieldPriceMin')}
                  value={form.priceMin}
                  onChange={(priceMin) => setForm({ ...form, priceMin })}
                />
                <NumericInput
                  placeholder={t('products.fieldPriceMax')}
                  value={form.priceMax}
                  onChange={(priceMax) => setForm({ ...form, priceMax })}
                />
              </div>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-sm font-medium">{t('products.fieldCurrency')}</label>
              <input className="input-field" value={salonCurrency} readOnly />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium">{t('products.fieldSupplier')}</label>
              <input
                className="input-field"
                value={form.supplier}
                onChange={(e) => setForm({ ...form, supplier: e.target.value })}
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500"
              checked={form.markedForPurchase}
              onChange={(e) => setForm({ ...form, markedForPurchase: e.target.checked })}
            />
            {t('products.markedForPurchase')}
          </label>
          {formError ? (
            <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
              {formError}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2 pt-2">
            <button type="button" onClick={() => setModalOpen(false)} className="btn-secondary">
              {t('common.cancel')}
            </button>
            <button type="submit" className="btn-primary" disabled={submitting}>
              {editing ? t('products.saveChanges') : t('products.createSubmit')}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
