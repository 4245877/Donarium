import type { CatalogQuery, Category, Product } from '@donarium/shared';
import type { CatalogRepository } from './repository.js';

export const demoCategories: Category[] = [
  { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', slug: 'decor', name: 'Декор' },
  { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', slug: 'miniatures', name: 'Миниатюры' },
  { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', slug: 'functional', name: 'Полезные вещи' },
];

const fixtures = [
  { key: 'vase', title: 'Спиральная ваза', description: 'Декоративная ваза с плавным спиральным рельефом. Пример карточки для печати в режиме вазы; геометрию и параметры печати предстоит добавить.', category: 0, tags: ['ваза', 'интерьер', 'спираль'], filename: 'spiral-vase.stl' },
  { key: 'dragon', title: 'Хранитель библиотеки', description: 'Коллекционная миниатюра дракона для настольной полки. Демонстрационная запись показывает, как объединить модель, описание и теги.', category: 1, tags: ['дракон', 'миниатюра', 'фэнтези'], filename: 'library-dragon.stl' },
  { key: 'organizer', title: 'Настольный органайзер', description: 'Модульный органайзер для инструментов и мелочей. В будущем к карточке можно привязать несколько версий и исходный проект.', category: 2, tags: ['органайзер', 'рабочее место', 'хранение'], filename: 'desk-organizer.3mf' },
  { key: 'planter', title: 'Геометрическое кашпо', description: 'Кашпо с геометрическими гранями для небольшого растения. Демонстрационный объект библиотеки; оригинальный файл пока не подключён.', category: 0, tags: ['кашпо', 'растения', 'геометрия'], filename: 'geometric-planter.stl' },
  { key: 'gear', title: 'Планетарный механизм', description: 'Пример функциональной модели: набор деталей планетарного механизма. Файлы сборки и документацию можно будет хранить рядом с 3D-моделями.', category: 2, tags: ['механика', 'шестерня', 'сборка'], filename: 'planetary-gear.3mf' },
  { key: 'lamp', title: 'Лунный светильник', description: 'Декоративный корпус светильника с мягкой рифлёной поверхностью. Карточка демонстрирует место для изображения, версии модели и связанного ресурса.', category: 0, tags: ['светильник', 'интерьер', 'луна'], filename: 'moon-lamp.stl' },
];

/** Illustrations and metadata only: no original model files are supplied. */
export const demoProducts: Product[] = fixtures.map((fixture, index) => {
  const digit = String(index + 1);
  const id = `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
  const date = `2026-01-${String(index + 10).padStart(2, '0')}T12:00:00.000Z`;
  return {
    id,
    sku: `DN-${String(index + 1).padStart(3, '0')}`,
    status: 'ready', coverAssetId: null,
    title: fixture.title,
    description: fixture.description,
    categories: [demoCategories[fixture.category]!],
    tags: fixture.tags,
    image: { url: `/illustrations/${fixture.key}.svg`, alt: `Иллюстрация: ${fixture.title}` },
    assetCount: 1,
    createdAt: date,
    updatedAt: date,
    sourceUrl: null,
    assets: [{
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      kind: 'model', name: fixture.filename,
      mediaType: fixture.filename.endsWith('.3mf') ? 'model/3mf' : 'model/stl',
      sizeBytes: null, sha256: null, version: '1.0', storageId: 'demo',
      relativePath: `models/${fixture.key}/${fixture.filename}`, externalUrl: null,
    }],
  };
});

export class DemoRepository implements CatalogRepository {
  async list(query: CatalogQuery) {
    const needle = query.q.toLocaleLowerCase('ru');
    const filtered = demoProducts.filter(product =>
      (!query.category || product.categories.some(category => category.slug === query.category)) &&
      (!query.tag || product.tags.some(tag => tag.toLocaleLowerCase('ru') === query.tag?.toLocaleLowerCase('ru'))) &&
      (!query.status || product.status === query.status) &&
      (!needle || [product.title, product.sku ?? '', product.description, ...product.tags].some(value => value.toLocaleLowerCase('ru').includes(needle))),
    );
    filtered.sort(query.sort === 'title'
      ? (a, b) => a.title.localeCompare(b.title, 'ru') || a.id.localeCompare(b.id)
      : query.sort === 'updated' ? (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)
      : (a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    const start = (query.page - 1) * query.pageSize;
    return { items: filtered.slice(start, start + query.pageSize).map(({ assets: _assets, sourceUrl: _sourceUrl, ...summary }) => summary), total: filtered.length };
  }

  async get(id: string) { return demoProducts.find(product => product.id === id) ?? null; }
  async categories() { return demoCategories; }
}
