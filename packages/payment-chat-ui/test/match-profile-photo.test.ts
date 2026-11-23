import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { MatchProfilePhoto } from '../../../src/components/match-profile-photo';

it('renders the signed B photo URL with an accessible name and direct private-image fetch', () => {
  const html = renderToStaticMarkup(createElement(MatchProfilePhoto, {
    nickname: '사진 있는 인연', photoUrl: 'https://project.example.test/storage/v1/object/sign/profile-photos/user/photo.jpg?token=test-only',
  }));
  expect(html).toContain('src="https://project.example.test/storage/v1/object/sign/profile-photos/user/photo.jpg?token=test-only"');
  expect(html).toContain('alt="사진 있는 인연 프로필 사진"');
  expect(html).toContain('loading="lazy"');
  expect(html).toContain('referrerPolicy="no-referrer"');
  expect(html).not.toContain('/_next/image');
});

it('keeps the existing avatar when a profile has no photo', () => {
  const html = renderToStaticMarkup(createElement(MatchProfilePhoto, { nickname: '가상 인연', photoUrl: null }));
  expect(html).toContain('avatar-letter');
  expect(html).toContain('>가</span>');
  expect(html).not.toContain('<img');
});
