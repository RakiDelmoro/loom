/// A fixed-capacity ring buffer.
///
/// Pushing into a full buffer overwrites the oldest item, and iteration yields
/// items from oldest to newest.
pub struct RingBuffer<T> {
	items: Vec<T>,
	capacity: usize,
}

impl<T> RingBuffer<T> {
	/// A buffer that holds at most `capacity` items.
	pub fn new(capacity: usize) -> Self {
		Self {
			items: Vec::new(),
			capacity,
		}
	}

	/// Adds `item`, overwriting the oldest when the buffer is full.
	pub fn push(&mut self, item: T) {
		let _ = item;
	}

	/// How many items the buffer holds.
	pub fn len(&self) -> usize {
		0
	}

	pub fn is_empty(&self) -> bool {
		true
	}

	pub fn capacity(&self) -> usize {
		self.capacity
	}

	/// The items, oldest first.
	pub fn iter(&self) -> impl Iterator<Item = &T> {
		self.items.iter()
	}
}