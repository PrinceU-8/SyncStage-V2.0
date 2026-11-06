from django.contrib import admin
from .models import SongProject, Section, Measure

class SectionInline(admin.TabularInline):
    model = Section
    extra = 0

class MeasureInline(admin.TabularInline):
    model = Measure
    extra = 0

@admin.register(SongProject)
class SongProjectAdmin(admin.ModelAdmin):
    list_display = ('id', 'title', 'slug', 'default_key', 'bpm', 'total_measures', 'is_pin_protected', 'created_at', 'updated_at')
    search_fields = ('title', 'slug')
    list_filter = ('default_key', 'created_at')
    inlines = [SectionInline, MeasureInline]

    @admin.display(boolean=True, description='PIN Protected')
    def is_pin_protected(self, obj):
        return bool(obj.edit_pin)

    def has_delete_permission(self, request, obj=None):
        # Admin-level permission: superuser or staff with explicit delete permission
        if not request.user or not request.user.is_active:
            return False
        return bool(request.user.is_superuser or (request.user.is_staff and request.user.has_perm('stage.delete_songproject')))

    def delete_model(self, request, obj):
        """Admin-level deletion bypassing PIN."""
        if obj.audio_file:
            obj.audio_file.delete(save=False)
        super().delete_model(request, obj)

    def delete_queryset(self, request, queryset):
        """Admin-level bulk deletion bypassing PIN."""
        for obj in queryset:
            if obj.audio_file:
                obj.audio_file.delete(save=False)
        super().delete_queryset(request, queryset)