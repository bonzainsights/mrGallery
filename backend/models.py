import enum
from sqlalchemy import Column, String, Integer, Float, Boolean, Enum, ForeignKey
from sqlalchemy.orm import relationship
try:
    from .database import Base
except ImportError:
    from database import Base

class MediaKind(str, enum.Enum):
    IMAGE = "image"
    VIDEO = "video"
    UNKNOWN = "unknown"

class MediaItem(Base):
    __tablename__ = "media_items"

    id = Column(String, primary_key=True, index=True)
    path = Column(String, unique=True, index=True, nullable=False)
    name = Column(String, nullable=False)
    extension = Column(String, nullable=False)
    kind = Column(Enum(MediaKind), nullable=False)
    size = Column(Integer, nullable=False)
    modifiedAt = Column(Float, nullable=False)
    createdAt = Column(Float, nullable=True)
    takenAt = Column(Float, nullable=True)
    folder = Column(String, index=True, nullable=False)
    width = Column(Integer, nullable=True)
    height = Column(Integer, nullable=True)
    latitude = Column(Float, nullable=True)
    longitude = Column(Float, nullable=True)
    duration = Column(Float, nullable=True)
    fingerprint = Column(String, nullable=True)
    perceptualHash = Column(String, nullable=True)
    selected = Column(Boolean, default=False)
    kept = Column(Boolean, default=False)
    face_scanned = Column(Boolean, default=False)
    
    faces = relationship("Face", back_populates="item", cascade="all, delete-orphan")

class Face(Base):
    __tablename__ = "faces"

    id = Column(String, primary_key=True, index=True)
    item_id = Column(String, ForeignKey("media_items.id"), index=True, nullable=False)
    person_name = Column(String, index=True, nullable=True) # "Unknown" if not assigned
    embedding = Column(String, nullable=False) # JSON list of floats
    box_x = Column(Integer, nullable=False)
    box_y = Column(Integer, nullable=False)
    box_w = Column(Integer, nullable=False)
    box_h = Column(Integer, nullable=False)
    
    item = relationship("MediaItem", back_populates="faces")
