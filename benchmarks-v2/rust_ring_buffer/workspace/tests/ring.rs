use ring_buffer::RingBuffer;

#[test]
fn a_new_buffer_is_empty() {
	let buffer: RingBuffer<i32> = RingBuffer::new(2);
	assert!(buffer.is_empty());
	assert_eq!(buffer.len(), 0);
	assert_eq!(buffer.capacity(), 2);
}

#[test]
fn keeps_items_in_the_order_they_were_pushed() {
	let mut buffer = RingBuffer::new(3);
	buffer.push(1);
	buffer.push(2);
	assert_eq!(buffer.iter().copied().collect::<Vec<_>>(), vec![1, 2]);
	assert_eq!(buffer.len(), 2);
	assert!(!buffer.is_empty());
}

#[test]
fn overwrites_the_oldest_when_full() {
	let mut buffer = RingBuffer::new(3);
	for value in 1..=4 {
		buffer.push(value);
	}
	assert_eq!(buffer.iter().copied().collect::<Vec<_>>(), vec![2, 3, 4]);
	assert_eq!(buffer.len(), 3);
}

#[test]
fn keeps_overwriting_after_the_first_wrap() {
	let mut buffer = RingBuffer::new(2);
	for value in 1..=5 {
		buffer.push(value);
	}
	assert_eq!(buffer.iter().copied().collect::<Vec<_>>(), vec![4, 5]);
}

#[test]
fn a_full_buffer_reports_its_capacity_as_its_length() {
	let mut buffer = RingBuffer::new(2);
	buffer.push("a");
	buffer.push("b");
	assert_eq!(buffer.len(), 2);
	assert_eq!(buffer.capacity(), 2);
}