import type { RestaurantPreparationTaskStatus } from './api-types';

export function nextPreparationTaskStatus(
  status: RestaurantPreparationTaskStatus,
): Exclude<RestaurantPreparationTaskStatus, 'queued'> | null {
  switch (status) {
    case 'queued':
      return 'preparing';
    case 'preparing':
      return 'ready';
    case 'ready':
      return 'served';
    case 'served':
      return null;
  }
}

export function preparationTaskActionLabel(status: RestaurantPreparationTaskStatus): string | null {
  switch (status) {
    case 'queued':
      return 'بدء التحضير';
    case 'preparing':
      return 'جاهز';
    case 'ready':
      return 'تم التقديم';
    case 'served':
      return null;
  }
}
