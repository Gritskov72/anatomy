# Источники и лицензии

## 3D-модели

**Z-Anatomy - The libre 3D atlas of anatomy - CC BY-SA 4.0**
Авторы: Gauthier Kervyn (дизайн, 3D, анатомия), Marcin Zielinski (скрипты Blender), Lluis Vinent (Unity).
Источник: https://github.com/Z-Anatomy/Models-of-human-anatomy (файл `Z-Anatomy.zip`, шаблон Blender `Startup.blend`, скачан 23.11.2026).
Лицензия: Creative Commons Attribution-ShareAlike 4.0 International, https://creativecommons.org/licenses/by-sa/4.0/
Текст лицензии источника: `sources/z-anatomy/repo/License.txt`.

Z-Anatomy построен на базе:

**BodyParts3D - The Database Center for Life Science - CC BY-SA 2.1 Japan**
Автор исходной модели: Kousaku Okubo.
Источник: https://dbarchive.biosciencedbc.jp/en/bodyparts3d/download.html
Лицензия: https://creativecommons.org/licenses/by-sa/2.1/jp/

По данным Z-Anatomy, в атлас включены и адаптированы также:
- "Brainder" и "White matter", University of Washington;
- "Cranial Nerves and Foramina", University of Dundee, CAHID - CC BY 4.0;
- "Anatomy of the Inner Ear", University of Dundee School of Medicine - CC BY-NC-SA 4.0;
- "Kidney", Lissie Cowley - CC BY-NC 4.0.

Две последние модели разрешены только для некоммерческого использования. Приложение личное и некоммерческое, поэтому условие соблюдено. При коммерческой публикации внутреннее ухо и почку нужно заменить моделями BodyParts3D.

## Что изменено

Модели Z-Anatomy экспортированы из Blender в GLB, упрощены и сжаты (meshopt), цвета материалов перенесены в цвета вершин, узлам даны стабильные имена. Производные модели в `app/models/` распространяются на тех же условиях CC BY-SA 4.0.

## Названия

- Английские названия: имена объектов Z-Anatomy (соответствуют Terminologia Anatomica 2).
- Латинские названия: таблица `TA2.csv` из репозитория Z-Anatomy (CC BY-SA 4.0), для отсутствующих там - Wikidata.
- Русские названия: Wikidata (CC0, https://www.wikidata.org), сопоставление по TA98 ID, FMA ID, латинскому и английскому названию. Чего нет в Wikidata, переведено по русской анатомической номенклатуре (атласы Синельникова и Сапина), такие записи помечены в каталоге `"ruSource": "перевод"`.

## Строка для экрана «О приложении»

3D-модели: Z-Anatomy (CC BY-SA 4.0) на основе BodyParts3D, The Database Center for Life Science (CC BY-SA 2.1 Japan). Названия: Terminologia Anatomica, Wikidata (CC0)
