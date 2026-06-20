import unittest

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.database import Base
from backend.main import DeleteFolderRequest, remove_folder
from backend.models import MediaItem, MediaKind


def make_item(item_id: str, path: str, folder: str) -> MediaItem:
    return MediaItem(
        id=item_id,
        path=path,
        name=f"{item_id}.jpg",
        extension=".jpg",
        kind=MediaKind.IMAGE,
        size=100,
        modifiedAt=1,
        folder=folder,
    )


class RemoveFolderBranchTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        self.session_factory = async_sessionmaker(self.engine, expire_on_commit=False)

    async def asyncTearDown(self):
        await self.engine.dispose()

    async def test_removes_folder_and_descendants_without_matching_sibling_prefixes(self):
        async with self.session_factory() as session:
            session.add_all([
                make_item("direct", "/Users/achbj/Movies/direct.jpg", "/Users/achbj/Movies"),
                make_item("child", "/Users/achbj/Movies/cache/child.jpg", "/Users/achbj/Movies/cache"),
                make_item("deep", "/Users/achbj/Movies/cache/deep/deep.jpg", "/Users/achbj/Movies/cache/deep"),
                make_item("sibling", "/Users/achbj/Movies-old/keep.jpg", "/Users/achbj/Movies-old"),
            ])
            await session.commit()

            result = await remove_folder(DeleteFolderRequest(folder="/Users/achbj/Movies"), session)

            remaining = (await session.execute(select(MediaItem.id))).scalars().all()
            self.assertEqual(result["deleted"], 3)
            self.assertEqual(remaining, ["sibling"])


if __name__ == "__main__":
    unittest.main()
