import { describe, expect, it } from 'vitest';
import { routeSectionPositions } from './front-back-matter';
import type { MarkerChunk } from './marker-sections';

function chunk(index: number, sectionLabel: string, startPage = index * 10 + 1): MarkerChunk {
  return { index, sectionLabel, bookmarkDepth: 1, startPage, markdown: '' };
}

describe('routeSectionPositions', () => {
  it('tags well-known front-matter labels as front', () => {
    const labels = [
      'Title Page',
      'Copyright',
      'Dedication',
      'Table of Contents',
      'Foreword',
      'Preface',
      'Acknowledgements',
      'Introduction',
      'Prologue',
    ];
    const out = routeSectionPositions(labels.map((l, i) => chunk(i, l)));
    expect(out.map((c) => c.position)).toEqual(labels.map(() => 'front'));
  });

  it('tags well-known back-matter labels as back', () => {
    const labels = [
      'Epilogue',
      'Afterword',
      'Appendix A',
      'Appendix',
      'Notes',
      'Endnotes',
      'Bibliography',
      'References',
      'Glossary',
      'Index',
      'About the Author',
    ];
    const out = routeSectionPositions(labels.map((l, i) => chunk(i, l)));
    expect(out.map((c) => c.position)).toEqual(labels.map(() => 'back'));
  });

  it('treats unrecognized labels in the middle of the book as body', () => {
    const out = routeSectionPositions([
      chunk(0, 'Preface'),
      chunk(1, 'Chapter 1: The Wakening'),
      chunk(2, 'Chapter 2: Renewal'),
      chunk(3, 'Appendix'),
    ]);
    expect(out.map((c) => c.position)).toEqual(['front', 'body', 'body', 'back']);
  });

  it('promotes leading unlabelled chunks before the first body chunk to front by ordinal', () => {
    // A book whose first two chunks have nondescript labels but precede an
    // obvious body chapter — by position, they belong to front matter.
    const out = routeSectionPositions([
      chunk(0, 'Opening Note'),
      chunk(1, 'A Letter'),
      chunk(2, 'Preface'),
      chunk(3, 'Chapter 1'),
      chunk(4, 'Chapter 2'),
    ]);
    expect(out.map((c) => c.position)).toEqual(['front', 'front', 'front', 'body', 'body']);
  });

  it('demotes trailing unlabelled chunks after the last body chunk to back by ordinal', () => {
    // Once we cross the first explicit back-matter chunk, every subsequent
    // chunk is back even if its label is unfamiliar.
    const out = routeSectionPositions([
      chunk(0, 'Chapter 1'),
      chunk(1, 'Chapter 2'),
      chunk(2, 'Appendix A'),
      chunk(3, 'Quirky Late Section'),
      chunk(4, 'Closing Words'),
    ]);
    expect(out.map((c) => c.position)).toEqual(['body', 'body', 'back', 'back', 'back']);
  });

  it('matches labels case-insensitively and ignores leading numeric/chapter prefixes', () => {
    const out = routeSectionPositions([
      chunk(0, 'PREFACE'),
      chunk(1, 'chapter 1'),
      chunk(2, '2. Renewal'),
      chunk(3, 'APPENDIX'),
    ]);
    expect(out.map((c) => c.position)).toEqual(['front', 'body', 'body', 'back']);
  });

  it('treats every chunk as body when there are no front/back markers', () => {
    const out = routeSectionPositions([chunk(0, 'Section A'), chunk(1, 'Section B')]);
    expect(out.map((c) => c.position)).toEqual(['body', 'body']);
  });
});
