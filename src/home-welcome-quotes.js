/** Цитаты о книгах для welcome-баннера на главной (ru / en), с контекстными пулами. */

const POOLS = {
  ru: {
    inviting: [
      { quote: 'Книги открывают двери туда, куда не ведут карты.', author: 'Дж. К. Роулинг' },
      { quote: 'Библиотека — это место, где хранятся все сны человечества.', author: 'Нил Гейман' },
      { quote: 'Книга — это мечта, которую можно взять в руки.', author: 'Нил Гейман' },
      { quote: 'Книга — сад, переносимый в кармане.', author: 'Арабская пословица' },
      { quote: 'Книга — это дом, который можно носить с собой.', author: 'Китайская пословица' },
      { quote: 'Читать — всё равно что путешествовать, не вставая с кресла.', author: 'Мигель де Сервантес' },
      { quote: 'Книги — это зеркало: в них видишь себя и мир.', author: 'Умберто Эко' },
      { quote: 'Стоит прочесть тысячу книг, чтобы обрести собственный голос.', author: 'Харуки Мураками' }
    ],
    morning: [
      { quote: 'Чтение — вот лучшее учение.', author: 'Александр Пушкин' },
      { quote: 'Чтение делает человека полным.', author: 'Фрэнсис Бэкон' },
      { quote: 'Чтение — дыхание для ума.', author: 'Даниэль Дефо' },
      { quote: 'Книга — это меч, который оттачивает ум.', author: 'Конфуций' },
      { quote: 'В книгах живут те, кто умел думать.', author: 'Ральф Уолдо Эмерсон' },
      { quote: 'Чтение хорошей книги — это беседа с великим умом прошлого.', author: 'Иоганн Вольфганг фон Гёте' },
      { quote: 'Книги — корабли мысли, странствующие по волнам времени.', author: 'Фрэнсис Бэкон' }
    ],
    afternoon: [
      { quote: 'Книги — это уникальная переносимая магия.', author: 'Стивен Кинг' },
      { quote: 'Книга — живой мозг, отлитый в тип.', author: 'Оноре де Бальзак' },
      { quote: 'Читать — значит жить чужими жизнями, не покидая своей комнаты.', author: 'Джордж Р. Р. Мартин' },
      { quote: 'Писатель пишет книгу, а читатель дописывает её для себя.', author: 'Марсель Пруст' },
      { quote: 'Книга учит нас говорить с теми, кого мы никогда не встретим.', author: 'Сенека' },
      { quote: 'Если одна книга утомляет вас, значит, вы прочли слишком мало.', author: 'Оскар Уайльд' },
      { quote: 'Комната без книг — как тело без души.', author: 'Цицерон' }
    ],
    evening: [
      { quote: 'Нет друзей вернее, чем книги.', author: 'Эрнест Хемингуэй' },
      { quote: 'Книги — самые тихие и стойкие друзья.', author: 'Чарльз Уильям Элиот' },
      { quote: 'Хорошая книга — лучший подарок, который можно сделать себе.', author: 'Уинстон Черчилль' },
      { quote: 'Читать — значит приобщаться к вечности.', author: 'Маргарет Этвуд' },
      { quote: 'Читатель проживает тысячу жизней, прежде чем умрёт. Тот, кто не читает, проживает лишь одну.', author: 'Джордж Р. Р. Мартин' },
      { quote: 'Книги — это корабли, на которых мы плывём сквозь время.', author: 'Эмили Дикинсон' },
      { quote: 'Чтение укрепляет душу.', author: 'Вольтер' }
    ],
    night: [
      { quote: 'Слово, написанное на бумаге, переживёт нас всех.', author: 'Эмили Бронте' },
      { quote: 'Книги — это уникальная переносимая магия.', author: 'Стивен Кинг' },
      { quote: 'Читать — значит приобщаться к вечности.', author: 'Маргарет Этвуд' },
      { quote: 'Книга — это мечта, которую можно взять в руки.', author: 'Нил Гейман' },
      { quote: 'Библиотека — это место, где хранятся все сны человечества.', author: 'Нил Гейман' },
      { quote: 'Книги — самые тихие и стойкие друзья.', author: 'Чарльз Уильям Элиот' },
      { quote: 'Нет друзей вернее, чем книги.', author: 'Эрнест Хемингуэй' }
    ]
  },
  en: {
    inviting: [
      { quote: 'A book is a dream that you hold in your hand.', author: 'Neil Gaiman' },
      { quote: 'Books are the plane, and the train, and the road. They are the destination and the journey.', author: 'Anna Quindlen' },
      { quote: 'A book is a gift you can open again and again.', author: 'Garrison Keillor' },
      { quote: 'Reading gives us someplace to go when we have to stay where we are.', author: 'Mason Cooley' },
      { quote: 'I have always imagined that Paradise will be a kind of library.', author: 'Jorge Luis Borges' },
      { quote: 'Books are the compass that orients us in the world.', author: 'Umberto Eco' },
      { quote: 'A book is a device to ignite the imagination.', author: 'Alan Bennett' },
      { quote: 'Reading is dreaming with open eyes.', author: 'Anissa Trisdianti' }
    ],
    morning: [
      { quote: 'Reading is to the mind what exercise is to the body.', author: 'Joseph Addison' },
      { quote: 'To learn to read is to light a fire; every syllable that is spelled out is a spark.', author: 'Victor Hugo' },
      { quote: 'Reading furnishes the mind only with materials of knowledge; it is thinking that makes what we read ours.', author: 'John Locke' },
      { quote: 'Books are the training weights of the mind.', author: 'Epictetus' },
      { quote: 'Reading is essential for those who seek to rise above the ordinary.', author: 'Jim Rohn' },
      { quote: 'The reading of all good books is like conversation with the finest minds of past centuries.', author: 'René Descartes' },
      { quote: 'Books are ships that sail the seas of time.', author: 'Francis Bacon' }
    ],
    afternoon: [
      { quote: 'Books are a uniquely portable magic.', author: 'Stephen King' },
      { quote: 'A reader lives a thousand lives before he dies. The man who never reads lives only one.', author: 'George R. R. Martin' },
      { quote: 'If one cannot enjoy reading a book over and over again, there is no use in reading it at all.', author: 'Oscar Wilde' },
      { quote: 'A room without books is like a body without a soul.', author: 'Cicero' },
      { quote: 'Books are the mirrors of the soul.', author: 'Virginia Woolf' },
      { quote: 'A book must be the axe for the frozen sea within us.', author: 'Franz Kafka' },
      { quote: 'Books are the treasured wealth of the world.', author: 'Henry David Thoreau' }
    ],
    evening: [
      { quote: 'There is no friend as loyal as a book.', author: 'Ernest Hemingway' },
      { quote: 'Books are the quietest and most constant of friends.', author: 'Charles W. Eliot' },
      { quote: 'A good book has no ending.', author: 'R. D. Cumming' },
      { quote: 'Reading makes immigrants of us all — it takes us away from home, but more important, it finds homes for us everywhere.', author: 'Jean Rhys' },
      { quote: 'Books are the bees which carry the quickening pollen from one to another mind.', author: 'James Russell Lowell' },
      { quote: 'Books are a form of political action. Books are knowledge. Books are reflection. Books change your mind.', author: 'Toni Morrison' },
      { quote: 'A library is a hospital for the mind.', author: 'Anonymous' }
    ],
    night: [
      { quote: 'Books are a uniquely portable magic.', author: 'Stephen King' },
      { quote: 'Reading is dreaming with open eyes.', author: 'Anissa Trisdianti' },
      { quote: 'There is no friend as loyal as a book.', author: 'Ernest Hemingway' },
      { quote: 'Books are the quietest and most constant of friends.', author: 'Charles W. Eliot' },
      { quote: 'Reading gives us someplace to go when we have to stay where we are.', author: 'Mason Cooley' },
      { quote: 'I have always imagined that Paradise will be a kind of library.', author: 'Jorge Luis Borges' },
      { quote: 'A book is a dream that you hold in your hand.', author: 'Neil Gaiman' }
    ]
  }
};

function normalizeLocale(locale) {
  return locale === 'en' ? 'en' : 'ru';
}

export function getHomeQuoteContext(hour = new Date().getHours(), inviting = false) {
  if (inviting) return 'inviting';
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 22) return 'evening';
  return 'night';
}

export function getHomeWelcomeQuotes(locale = 'ru') {
  const loc = normalizeLocale(locale);
  const pools = POOLS[loc];
  return Object.values(pools).flat();
}

export function getHomeWelcomeQuotePool(locale = 'ru', { inviting = false, hour } = {}) {
  const loc = normalizeLocale(locale);
  const ctx = getHomeQuoteContext(hour ?? new Date().getHours(), inviting);
  return POOLS[loc][ctx] || POOLS[loc].inviting;
}

export function pickHomeWelcomeQuote(locale = 'ru', options = {}) {
  const list = getHomeWelcomeQuotePool(locale, options);
  if (!list.length) return { quote: '', author: '' };
  return list[Math.floor(Math.random() * list.length)];
}

/** JSON для встраивания в HTML (безопасно внутри script type=application/json). */
export function serializeHomeWelcomeQuotes(locale = 'ru') {
  return JSON.stringify(POOLS[normalizeLocale(locale)]).replace(/</g, '\\u003c');
}
